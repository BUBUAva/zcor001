sap.ui.define([
	"sap/ui/core/mvc/ControllerExtension",
	"sap/ui/mdc/p13n/StateUtil",
	"sap/m/MessageBox",
	"sap/ui/core/BusyIndicator",
	"sap/ui/model/json/JSONModel",
	// Internal (non-public) module - it is the same one SAP's own "Freeze up to this column" column-header
	// menu uses to change fixedColumnCount on an already-rendered GridTable. There is no public API for
	// this; if a future SAPUI5 upgrade removes/renames it, freezing columns will need to be revisited.
	"sap/ui/mdc/table/utils/Personalization"
], function (ControllerExtension, StateUtil, MessageBox, BusyIndicator, JSONModel, TablePersonalizationUtils) {
	"use strict";

	var FISCAL_MONTHS = ["Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"];
	var FISCAL_MONTHS_FULL = ["August", "September", "October", "November", "December", "January", "February", "March", "April", "May", "June", "July"];

	// exportToExcel is a bound action on the ManagementReportComparision entity set (not an unbound action
	// at the service root), invoked as "/<EntitySet>/<namespace>.<action>(...)".
	var EXPORT_ACTION_FQN = "com.sap.gateway.srvd.zco_ui_zcor001.v0001.exportToExcel";
	var EXPORT_ACTION_BINDING_ENTITY_SET = "ManagementReportComparision";

	// Maps the Filter Bar's property name to the exportToExcel action's own (uppercase, ABAP-style) parameter name.
	// Modify by Avally-Achawin start: 2026-09-10 15:10 - re-added PlanningCategory/ProfitCenter/ProcessingType
	// for good. Dropping them (2026-09-10 14:35) broke the call with "No value for mandatory parameter
	// 'PLA...' specified" - PLANNINGCATEGORY (and by the same structure, PROFITCENTER/PROCESSINGTYPE too) is a
	// mandatory action parameter on the backend, so all 12 fields must always be sent, even empty. The real
	// bug was only ever SHOWGLACCOUNT needing a string "X"/"" instead of a JSON boolean (fixed in
	// toAbapBoolean() above) - it was never about which/how many of these 12 fields were included.
	var EXPORT_PARAM_MAP = {
		CompanyCode: "COMPANYCODE",
		FiscalYear: "FISCALYEAR",
		FiscalPeriod: "FISCALPERIOD",
		ComparisonYear: "COMPARISONYEAR",
		ComparisonPeriod: "COMPARISONPERIOD",
		PlanningCategory: "PLANNINGCATEGORY",
		ProfitCenter: "PROFITCENTER",
		ProfitCenterHierarchy: "PROFITCENTERHIER",
		GLAccount: "GLACCOUNT",
		GLAccountHierarchy: "GLACCOUNTHIER",
		ProcessingType: "PROCESSINGTYPE",
		ShowGLAccount: "SHOWGLACCOUNT"
	};
	// Modify by Avally-Achawin end: 2026-09-10 15:10
	// Modify by Avally-Achawin end: 2026-09-10 14:35
	// Modify by Avally-Achawin end: 2026-09-10 10:15

	// Candidate key names to try, in order, when reading the action's result (guid / file name).
	var GUID_RESULT_KEYS = ["guid", "Guid", "GUID", "Uuid", "uuid"];
	var FILE_NAME_RESULT_KEYS = ["file_name", "FileName", "fileName", "FILE_NAME"];

	// ExportBuffer holds the generated file. ExpFileContent is a genuine OData V4 media-stream property
	// (not inlined in the entity's JSON), so it is fetched separately via its own URL.
	var EXPORT_BUFFER_ENTITY_SET = "ExportBuffer";
	var EXPORT_BUFFER_CONTENT_PROPERTY = "ExpFileContent";
	var EXPORT_BUFFER_FILENAME_PROPERTY = "ExpFileName";
	var EXPORT_BUFFER_MIMETYPE_PROPERTY = "ExpMimeType";

	// Hardcoded to match manifest.json's sap.app/dataSources/mainService/uri. This cannot be looked up at
	// runtime via sap.ui.core.Component.getOwnerComponentFor(view) - that returns the embedded
	// sap.fe.templates.ListReport component, not this app's own Component.js, and its manifest has no
	// dataSources entry. This is a server-relative path, so a plain fetch() against it resolves correctly
	// regardless of which environment (local preview, deployed BSP, ...) the app is served from.
	var MAIN_SERVICE_URL = "/sap/opu/odata4/sap/zco_zcor001_srv/srvd/sap/zco_ui_zcor001/0001/";

	function pickValue(oObject, aCandidateKeys) {
		if (!oObject) {
			return undefined;
		}
		for (var i = 0; i < aCandidateKeys.length; i++) {
			if (Object.prototype.hasOwnProperty.call(oObject, aCandidateKeys[i])) {
				return oObject[aCandidateKeys[i]];
			}
		}
		return undefined;
	}

	function normalizeGuid(sGuid) {
		if (!sGuid) {
			return "";
		}
		var sHex = String(sGuid).replace(/[^0-9a-fA-F]/g, "");
		if (sHex.length !== 32) {
			// Not a plain 32-hex string (e.g. already dashed, or not a guid at all) - return as-is.
			return String(sGuid);
		}
		return (
			sHex.substr(0, 8) + "-" + sHex.substr(8, 4) + "-" + sHex.substr(12, 4) + "-" +
			sHex.substr(16, 4) + "-" + sHex.substr(20, 12)
		).toLowerCase();
	}

	function isZeroGuid(sGuid) {
		if (!sGuid) {
			return true;
		}
		return /^[0-]+$/.test(String(sGuid));
	}

	// Reads one Filter Bar condition's current value(s) out of the map returned by
	// StateUtil.retrieveExternalState(oFilterBar).filter.
	// Modify by Avally-Achawin start: 2026-09-10 17:05 - now joins every selected value with a comma instead
	// of returning only aConditions[0].values[0]. A multi-select Filter Bar field (e.g. PlanningCategory)
	// produces one condition entry per chosen value; reading just the first one silently dropped every value
	// after the first when exporting. The backend's exporttoexcel method now SPLITs this same
	// comma-separated string back into individual range entries (one per value), so this must match that.
	function getConditionValue(mConditions, sProperty) {
		var aConditions = mConditions[sProperty] || [];

		return aConditions
			.map(function (oCondition) {
				return oCondition && oCondition.values && oCondition.values[0];
			})
			.filter(function (vValue) {
				return vValue !== undefined && vValue !== null && vValue !== "";
			})
			.join(",");
	}
	// Modify by Avally-Achawin end: 2026-09-10 17:05

	// Reads the current Filter Bar conditions (via StateUtil, the documented mdc way to read filter
	// state programmatically) and turns them into the exportToExcel action's parameter payload.
	// Modify by Avally-Achawin start: 2026-09-10 16:20 - removed the ShowGLAccount -> toAbapBoolean("X"/"")
	// special case. SHOWGLACCOUNT's FilterDefaultValue annotation is "N" (not "" / not the ABAP_BOOL "X"
	// convention assumed earlier), so the Filter Bar's actual on/off values are backend-defined domain values
	// (e.g. "Y"/"N") - forcing them into "X"/"" was wrong and made ls_param-showglaccount arrive blank even
	// when the user selected "show", so the exported Excel never included the GL Account column. Every other
	// filter field is already passed through as the raw Filter Bar value unmodified; ShowGLAccount now follows
	// the same pattern and trusts whatever value its own value help/dropdown actually provides.
	function buildExportParameters(oFilterState) {
		var mConditions = (oFilterState && oFilterState.filter) || {};
		var mParams = {};

		Object.keys(EXPORT_PARAM_MAP).forEach(function (sFilterProperty) {
			var sActionParam = EXPORT_PARAM_MAP[sFilterProperty];

			mParams[sActionParam] = getConditionValue(mConditions, sFilterProperty);
		});

		return mParams;
	}
	// Modify by Avally-Achawin end: 2026-09-10 16:20

	// Downloads the export file: fetches the ExportBuffer entity's plain properties (filename/mimetype) via
	// the OData model, then separately fetches the ExpFileContent media stream and triggers a browser download.
	function downloadExportFile(oModel, sGuid, sFileName) {
		var sNormalizedGuid = normalizeGuid(sGuid);

		var oContextBinding = oModel.bindContext(
			"/" + EXPORT_BUFFER_ENTITY_SET + "(Guid=" + sNormalizedGuid + ")",
			undefined,
			{ $select: [EXPORT_BUFFER_FILENAME_PROPERTY, EXPORT_BUFFER_MIMETYPE_PROPERTY, "SAP__Messages"].join(",") }
		);

		return oContextBinding.getBoundContext().requestObject()
			.then(function (oData) {
				var sStreamUrl = MAIN_SERVICE_URL + EXPORT_BUFFER_ENTITY_SET +
					"(Guid=" + sNormalizedGuid + ")/" + EXPORT_BUFFER_CONTENT_PROPERTY;

				return fetch(sStreamUrl, { credentials: "same-origin" }).then(function (oResponse) {
					if (!oResponse.ok) {
						throw new Error("HTTP " + oResponse.status + " fetching " + sStreamUrl);
					}
					return oResponse.blob();
				}).then(function (oBlob) {
					var sObjectUrl = URL.createObjectURL(oBlob);
					var oLink = document.createElement("a");
					oLink.href = sObjectUrl;
					oLink.download = sFileName || oData[EXPORT_BUFFER_FILENAME_PROPERTY] || "export.xlsx";
					document.body.appendChild(oLink);
					oLink.click();
					document.body.removeChild(oLink);
					URL.revokeObjectURL(sObjectUrl);
				});
			});
	}

	// this.base.getExtensionAPI().getFilterBar() does not exist on sap.fe.templates.ListReport.ExtensionAPI
	// (verified against SAP's official @sapui5/types) - the FilterBar is resolved directly instead, via the
	// table's own documented "filter" association, falling back to a tree search when no table is available yet.
	function findFilterBar(oView, oTable) {
		var sFilterBarId = oTable && oTable.getFilter && oTable.getFilter();
		var oFilterBar = sFilterBarId && sap.ui.core.Element.getElementById(sFilterBarId);

		if (oFilterBar) {
			return oFilterBar;
		}

		return oView.findAggregatedObjects(true, function (oControl) {
			return oControl.isA && oControl.isA("sap.ui.mdc.filterbar.FilterBarBase");
		})[0] || null;
	}

	// A filter field's F4 value help (e.g. FiscalYear) has its own internal results table - a separate
	// sap.ui.mdc.Table that stays in the view's control tree as a dependent even after the dialog closes.
	// Excluding anything whose id contains "FilterFieldValueHelp" keeps this from ever being mistaken for
	// the actual report table.
	function isReportTable(oControl) {
		return !!(oControl && oControl.isA && oControl.isA("sap.ui.mdc.Table") &&
			oControl.getId().indexOf("FilterFieldValueHelp") === -1);
	}

	function findMdcTable(oView, oCandidate) {
		if (isReportTable(oCandidate)) {
			return oCandidate;
		}

		return oView.findAggregatedObjects(true, isReportTable)[0] || null;
	}

	function findTitleControl(oControl) {
		if (!oControl) {
			return null;
		}
		if (oControl.isA && oControl.isA("sap.m.Title")) {
			return oControl;
		}
		var mAggregations = oControl.getMetadata ? oControl.getMetadata().getAllAggregations() : {};
		for (var sName in mAggregations) {
			var vValue = oControl.getAggregation ? oControl.getAggregation(sName) : null;
			if (!vValue) {
				continue;
			}
			var aChildren = Array.isArray(vValue) ? vValue : [vValue];
			for (var i = 0; i < aChildren.length; i++) {
				var oFound = findTitleControl(aChildren[i]);
				if (oFound) {
					return oFound;
				}
			}
		}
		return null;
	}

	// Builds the report title text, used for both the page title and the table's own header.
	function buildTitleText(sFiscalPeriod, sFiscalYear) {
		var iPeriod = parseInt(sFiscalPeriod, 10);

		if (isNaN(iPeriod) || iPeriod < 1 || iPeriod > 12 || !sFiscalYear) {
			return null;
		}

		var sMonth = FISCAL_MONTHS_FULL[iPeriod - 1];
		// Periods 6-12 (Jan-Jul) roll into the next calendar year - same rule as the CAmount/RBAmount column labels.
		var iBaseYear = parseInt(sFiscalYear, 10);
		var iCalendarYear = isNaN(iBaseYear) ? sFiscalYear : (iPeriod <= 5 ? iBaseYear : iBaseYear + 1);
		return "Management Report for the Academic Year " + sMonth + " " + iCalendarYear + " (THB) Consolidation";
	}

	return ControllerExtension.extend("zcor001.ext.controller.ListReportExt", {
		// Modify by Avally-Achawin start: 2026-09-15 - create the "localExt" model (exportEnabled
		// defaulting to false) as early as onInit instead of lazily inside onBeforeRebindTable. Before the
		// user ever presses "Go", onBeforeRebindTable has not run yet, so "localExt" did not exist - an
		// unresolved "{localExt>/exportEnabled}" binding on the Export to Excel button then falls back to
		// enabled, letting it be pressed with no data loaded at all (reported: button was clickable before
		// the first Go). Creating the model here so that binding always resolves to false until the table
		// actually reports rows.
		override: {
			onInit: function () {
				var oView = this.base.getView();
				if (!oView.getModel("localExt")) {
					oView.setModel(new JSONModel({ exportEnabled: false, freezeStatus: "-" }), "localExt");
				}
			}
		},
		// Modify by Avally-Achawin end: 2026-09-15

		// Wired via manifest.json's tableSettings.beforeRebindTable (the OData V4 extension point for
		// reacting to a table rebind) - NOT nested under "override", since this is not one of the
		// documented ListReportController overrides (onAfterClear/onPendingFilters/onViewNeedsRefresh).
		// Runs on every "Go": freezes the "Text" column, hides the "Currency" column, refreshes the page
		// title/table header/column labels, and enables the Export to Excel button.
		onBeforeRebindTable: function (oEvent) {
			try {
				var oTable = findMdcTable(this.base.getView(), oEvent.getSource());
				var oFilterBar = findFilterBar(this.base.getView(), oTable);

				// The "localExt" model is created directly on this view rather than relied upon from
				// manifest.json's sap.ui5/models - a model declared there on the outer AppComponent does not
				// propagate into this embedded ListReport component's view.
				var oView = this.base.getView();
				var oLocalExtModel = oView.getModel("localExt");
				if (!oLocalExtModel) {
					oLocalExtModel = new JSONModel({ exportEnabled: false, freezeStatus: "-" });
					oView.setModel(oLocalExtModel, "localExt");
				}
				// Modify by Avally-Achawin start: 2026-09-15 - exportEnabled is no longer forced to true on
				// every rebind. Export to Excel should only be pressable when the table actually has rows;
				// the real row count isn't known yet at onBeforeRebindTable time (the rebind hasn't fetched
				// data yet), so it's set from the "dataReceived" event of the table's own OData binding.
				// Confirmed via debug logging that this hook's actual event parameter is
				// "collectionBindingInfo" (not "bindingParams" as first assumed), an object exposing its own
				// attachEvent()/getAttachedEvents() API - using that (rather than poking at its internal
				// "collectionBindingInfo.events" object directly) keeps this additive alongside whatever
				// dataReceived handling Fiori elements itself already wires up (busy state, no-data text).
				var oCollectionBindingInfo = oEvent.getParameter && oEvent.getParameter("collectionBindingInfo");
				if (oCollectionBindingInfo && oCollectionBindingInfo.attachEvent) {
					oCollectionBindingInfo.attachEvent("dataReceived", function (oDataEvent) {
						var oBinding = oDataEvent.getSource();
						var bHasError = !!oDataEvent.getParameter("error");
						var iLength = (!bHasError && oBinding && oBinding.getLength) ? oBinding.getLength() : 0;
						oLocalExtModel.setProperty("/exportEnabled", iLength > 0);
					});
				}
				// Modify by Avally-Achawin end: 2026-09-15

				this._freezeLeadingColumns(oTable, 1, oLocalExtModel);
				this._hideCurrencyColumn(oTable);

				StateUtil.retrieveExternalState(oFilterBar).then(function (oFilterState) {
					var mConditions = (oFilterState && oFilterState.filter) || {};
					var sFiscalPeriod = getConditionValue(mConditions, "FiscalPeriod");
					var sFiscalYear = getConditionValue(mConditions, "FiscalYear");

					this._updatePageTitle(sFiscalPeriod, sFiscalYear);
					this._updateTableHeader(oTable, sFiscalPeriod, sFiscalYear);
					this._updateRAmountColumnLabels(oTable, sFiscalPeriod);
					this._updateCalendarYearColumnLabels(oTable, sFiscalYear);

					// Modify by Avally-Achawin start: 2026-09-15 - notify the user when ProcessingType is set
					// to Background ('B'). Doing this here (frontend) instead of the query provider
					// (zcl_co_zcor001_rpt) because IF_RAP_QUERY_RESPONSE has no method to attach an
					// informational message to a successful response (confirmed by an ABAP syntax error when
					// that was tried) - raising cx_rap_query_provider instead would fail the whole table load
					// as an error, which is heavier than intended for a simple notice. Only shown on the
					// transition into 'B' (tracked via /lastProcessingType on the localExt model) so it does
					// not reappear on every rebind (sort/page/etc.) while 'B' stays selected.
					var sProcessingType = getConditionValue(mConditions, "ProcessingType");
					if (sProcessingType === "B" && oLocalExtModel.getProperty("/lastProcessingType") !== "B") {
						MessageBox.information("Background process has been processing");
					}
					oLocalExtModel.setProperty("/lastProcessingType", sProcessingType);
					// Modify by Avally-Achawin end: 2026-09-15
				}.bind(this)).catch(function (oError) {
					// eslint-disable-next-line no-console
					console.error("[ListReportExt] retrieveExternalState failed:", oError);
				});
			} catch (oError) {
				// eslint-disable-next-line no-console
				console.error("[ListReportExt] onBeforeRebindTable failed:", oError);
			}
		},

		_updatePageTitle: function (sFiscalPeriod, sFiscalYear) {
			var sTitleText = buildTitleText(sFiscalPeriod, sFiscalYear);

			if (!sTitleText) {
				return;
			}

			var oView = this.base.getView();
			var oDynamicPageTitle = oView.findAggregatedObjects(true, function (oControl) {
				return oControl.isA && oControl.isA("sap.f.DynamicPageTitle");
			})[0];

			if (!oDynamicPageTitle) {
				return;
			}

			var oTitleControl = findTitleControl(oDynamicPageTitle.getHeading());

			if (!oTitleControl) {
				return;
			}

			oTitleControl.setText(sTitleText);
		},

		// Sets the mdc.Table's own header text (the text shown directly above the table, distinct from the
		// page-level DynamicPageTitle) and disables the automatic "(N)" row-count suffix.
		_updateTableHeader: function (oTable, sFiscalPeriod, sFiscalYear) {
			var sTitleText = buildTitleText(sFiscalPeriod, sFiscalYear);

			if (!sTitleText || !oTable || !oTable.setHeader) {
				return;
			}

			oTable.setHeader(sTitleText);

			if (oTable.setShowRowCount) {
				oTable.setShowRowCount(false);
			}
		},

		// oTable.getType().setFixedColumnCount(iCount) sets the property but has no visual effect on a
		// table that has already been rendered once - the inner grid table's fixedColumnCount is only
		// wired up at creation time. The table's own "Freeze up to this column" menu instead goes through
		// the mdc p13n Engine (TablePersonalizationUtils.createFixedColumnCountChange), which correctly
		// updates the reactive state the already-rendered table is watching - so this does the same.
		_freezeLeadingColumns: function (oTable, iCount, oLocalExtModel) {
			function setStatus(sStatus) {
				if (oLocalExtModel) {
					oLocalExtModel.setProperty("/freezeStatus", sStatus);
				}
			}

			if (!oTable) {
				setStatus("no-table");
				return;
			}

			try {
				TablePersonalizationUtils.createFixedColumnCountChange(oTable, { fixedColumnCount: iCount });
				setStatus("engine-change-requested:" + iCount);
			} catch (oError) {
				// eslint-disable-next-line no-console
				console.error("[ListReportExt] createFixedColumnCountChange failed:", oError);
				setStatus("engine-change-error:" + oError);
			}
		},

		// Hides the "Currency" column entirely. A plain oColumn.setVisible(false) does not work (same class
		// of issue as fixedColumnCount above), so this goes through the public, documented mdc p13n Engine
		// facade instead - StateUtil.applyExternalState(oTable, {items: [{name, visible: false}]}).
		_hideCurrencyColumn: function (oTable) {
			if (!oTable) {
				return;
			}

			StateUtil.applyExternalState(oTable, {
				items: [ { name: "Currency", visible: false } ]
			}).catch(function (oError) {
				// eslint-disable-next-line no-console
				console.error("[ListReportExt] applyExternalState (hide Currency column) failed:", oError);
			});
		},

		_updateRAmountColumnLabels: function (oTable, sFiscalPeriod) {
			var iSelectedPeriod = parseInt(sFiscalPeriod, 10);
			var oColumns = (oTable && oTable.getColumns) ? oTable.getColumns() : [];

			oColumns.forEach(function (oColumn) {
				// sap.ui.mdc.table.Column always has a managed "propertyKey" property; read it generically
				// instead of relying on a specific getter method.
				var sPropertyKey = oColumn.getPropertyKey ? oColumn.getPropertyKey() : oColumn.getProperty("propertyKey");
				var oMatch = sPropertyKey && /^RAmount(\d{2})$/.exec(sPropertyKey);

				if (!oMatch || !oColumn.setHeader) {
					return;
				}

				var iColumnPeriod = parseInt(oMatch[1], 10);
				var sMonth = FISCAL_MONTHS[iColumnPeriod - 1];
				var sStatus = (!isNaN(iSelectedPeriod) && iColumnPeriod <= iSelectedPeriod) ? "ACT" : "BG";

				oColumn.setHeader(sMonth + " (" + sStatus + ")");
			});
		},

		_updateCalendarYearColumnLabels: function (oTable, sFiscalYear) {
			var iBaseYear = parseInt(sFiscalYear, 10);

			if (isNaN(iBaseYear)) {
				return;
			}

			var oColumns = (oTable && oTable.getColumns) ? oTable.getColumns() : [];

			oColumns.forEach(function (oColumn) {
				var sPropertyKey = oColumn.getPropertyKey ? oColumn.getPropertyKey() : oColumn.getProperty("propertyKey");
				var oMatch = sPropertyKey && /^(CAmount|RBAmount)(\d{2})$/.exec(sPropertyKey);

				if (!oMatch || !oColumn.setHeader) {
					return;
				}

				var iColumnPeriod = parseInt(oMatch[2], 10);
				var sMonth = FISCAL_MONTHS[iColumnPeriod - 1].toUpperCase();
				var iCalendarYear = iColumnPeriod <= 5 ? iBaseYear : iBaseYear + 1;

				oColumn.setHeader(sMonth + " " + iCalendarYear);
			});
		},

		// Header action bound from manifest.json ("press": ".extension.zcor001.ext.controller.ListReportExt.onExportToExcel").
		// Reads the current Filter Bar state, calls the exportToExcel action, then downloads the generated file.
		onExportToExcel: function () {
			try {
				var oView = this.base.getView();
				var oResourceBundle = oView.getModel("i18n").getResourceBundle();
				var oModel = oView.getModel();
				var oFilterBar = findFilterBar(oView);

				BusyIndicator.show(0);

				StateUtil.retrieveExternalState(oFilterBar).then(function (oFilterState) {
					var mParams = buildExportParameters(oFilterState);
					var oActionBinding = oModel.bindContext("/" + EXPORT_ACTION_BINDING_ENTITY_SET + "/" + EXPORT_ACTION_FQN + "(...)");

					// Modify by Avally-Achawin start: 2026-09-14 - temporary debug log to see exactly what
					// gets sent to exportToExcel, since the backend is currently failing with a 500
					// (ABAP SYNTAX_ERROR dump) and we need to rule out a bad/oversized parameter value as
					// the trigger before chasing it purely on the backend side. Remove once root-caused.
					// eslint-disable-next-line no-console
					console.log("[ListReportExt] exportToExcel request params:", JSON.parse(JSON.stringify(mParams)));
					// Modify by Avally-Achawin end: 2026-09-14

					Object.keys(mParams).forEach(function (sParamName) {
						oActionBinding.setParameter(sParamName, mParams[sParamName]);
					});

					return oActionBinding.execute().then(function () {
						return oActionBinding.getBoundContext().requestObject();
					});
				}).then(function (oResult) {
					var sGuid = pickValue(oResult, GUID_RESULT_KEYS);
					var sFileName = pickValue(oResult, FILE_NAME_RESULT_KEYS);

					if (isZeroGuid(sGuid)) {
						throw new Error("ZERO_GUID");
					}

					return downloadExportFile(oModel, sGuid, sFileName);
				}).then(function () {
					BusyIndicator.hide();
				}).catch(function (oError) {
					BusyIndicator.hide();
					// eslint-disable-next-line no-console
					console.error("[ListReportExt] onExportToExcel failed:", oError);
					// Modify by Avally-Achawin start: 2026-09-14 - temporary debug log to surface every
					// detail UI5 attaches to the error (message/stack/cause and, for a raw HTTP failure,
					// the response status/body) - the generic "could not be downloaded" MessageBox hides
					// all of this from the user, but we need it to see what the backend actually returned
					// for the 500/SYNTAX_ERROR. Remove once root-caused.
					// eslint-disable-next-line no-console
					console.error("[ListReportExt] error detail - message:", oError && oError.message);
					// eslint-disable-next-line no-console
					console.error("[ListReportExt] error detail - stack:", oError && oError.stack);
					// eslint-disable-next-line no-console
					console.error("[ListReportExt] error detail - cause:", oError && oError.cause);
					// eslint-disable-next-line no-console
					console.error("[ListReportExt] error detail - status/body:", oError && (oError.status || oError.statusCode), oError && oError.responseText);
					// Modify by Avally-Achawin end: 2026-09-14

					var sMessage = (oError && oError.message === "ZERO_GUID")
						? oResourceBundle.getText("exportToExcelFailedMsg")
						: oResourceBundle.getText("exportToExcelDownloadFailedMsg");

					MessageBox.error(sMessage);
				});
			} catch (oError) {
				BusyIndicator.hide();
				// eslint-disable-next-line no-console
				console.error("[ListReportExt] onExportToExcel threw synchronously:", oError);
				MessageBox.error("Export to Excel failed. Please try again or contact your administrator.");
			}
		}
	});
});

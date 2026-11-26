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

	var FISCAL_MONTHS = ["AUG", "SEP", "OCT", "NOV", "DEC", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL"];


	// The backend flags hierarchy total/subtotal rows (e.g. GLAccountHierarchy roll-up lines) by
	// setting NodeStyle to "BOLD" on that row. NODE_STYLE_BOLD_CSS_CLASS is defined in css/style.css
	// (registered via manifest.json sap.ui5/resources/css) and makes the whole row's text bold.
	var NODE_STYLE_BOLD_VALUE = "BOLD";
	var NODE_STYLE_BOLD_CSS_CLASS = "zcor001NodeStyleBold";


	// exportToExcel is a bound action on the ManagementReportComparision entity set (not an unbound action
	// at the service root), invoked as "/<EntitySet>/<namespace>.<action>(...)".
	var EXPORT_ACTION_FQN = "com.sap.gateway.srvd.zco_ui_zcor001.v0001.exportToExcel";
	var EXPORT_ACTION_BINDING_ENTITY_SET = "ManagementReportComparision";

	// Maps the Filter Bar's property name to the exportToExcel action's own (uppercase, ABAP-style)
	// parameter name. All 12 fields are always sent, even when empty, because several of them are
	// mandatory action parameters on the backend. ShowGLAccount is passed through as the Filter Bar's raw
	// value unmodified - its on/off values are backend-defined domain values (e.g. "Y"/"N"), not the
	// ABAP_BOOL "X"/"" convention.
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


	// Candidate key names to try, in order, when reading the action's result (guid / file name / content).
	var GUID_RESULT_KEYS = ["guid", "Guid", "GUID", "Uuid", "uuid"];
	var FILE_NAME_RESULT_KEYS = ["file_name", "FileName", "fileName", "FILE_NAME"];
	// exportToExcel's action result carries the generated file's content directly (base64) for the
	// "Online" processing type, so the frontend never needs a separate request to fetch it.
	var CONTENT_RESULT_KEYS = ["file_content", "FileContent", "fileContent", "FILE_CONTENT"];

	// Constants for the "Application Log" header button's cross-app navigation.
	// ZCOAPPLOG_APPLICATION_ID must match the "Application" value the backend writes into the
	// ApplicationLog entity for every export triggered from this app (zcor001), so the navigated-to app's
	// filter actually matches only this app's own log entries.
	var ZCOAPPLOG_SEMANTIC_OBJECT = "zcoapplog";
	var ZCOAPPLOG_ACTION = "display";
	var ZCOAPPLOG_APPLICATION_ID = "ZCOR001";

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

	// Detects the backend's "no result" sentinel value - an all-zero GUID.
	function isZeroGuid(sGuid) {
		if (!sGuid) {
			return true;
		}
		return /^[0-]+$/.test(String(sGuid));
	}

	// Reads one Filter Bar condition's current value(s) out of the map returned by
	// StateUtil.retrieveExternalState(oFilterBar).filter. A multi-select field (e.g. PlanningCategory) can
	// produce more than one condition entry; all of them are joined with a comma, matching how the
	// backend's exporttoexcel method splits this same comma-separated string back into range entries.
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


	// Reads the current Filter Bar conditions (via StateUtil, the documented mdc way to read filter state
	// programmatically) and turns them into the exportToExcel action's parameter payload.
	function buildExportParameters(oFilterState) {
		var mConditions = (oFilterState && oFilterState.filter) || {};
		var mParams = {};

		Object.keys(EXPORT_PARAM_MAP).forEach(function (sFilterProperty) {
			var sActionParam = EXPORT_PARAM_MAP[sFilterProperty];

			mParams[sActionParam] = getConditionValue(mConditions, sFilterProperty);
		});

		return mParams;
	}


	// Decodes a base64 (or base64url - '-'/'_' instead of '+'/'/') string into a Blob. atob() only
	// understands standard base64, so '-'/'_' are normalized and padding is restored first.
	function base64ToBlob(sBase64, sMimeType) {
		var sNormalized = sBase64.replace(/-/g, "+").replace(/_/g, "/");
		while (sNormalized.length % 4 !== 0) {
			sNormalized += "=";
		}

		var sBinary = atob(sNormalized);
		var aBytes = new Uint8Array(sBinary.length);
		for (var i = 0; i < sBinary.length; i++) {
			aBytes[i] = sBinary.charCodeAt(i);
		}

		return new Blob([aBytes], { type: sMimeType || "application/octet-stream" });
	}

	// Triggers a browser download of the export file: decodes its base64 content into a Blob and clicks a
	// throwaway <a download> link.
	function downloadExportFile(sBase64Content, sFileName) {
		var oBlob = base64ToBlob(sBase64Content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		var sObjectUrl = URL.createObjectURL(oBlob);
		var oLink = document.createElement("a");
		oLink.href = sObjectUrl;
		oLink.download = sFileName || "export.xlsx";
		document.body.appendChild(oLink);
		oLink.click();
		document.body.removeChild(oLink);
		URL.revokeObjectURL(sObjectUrl);
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
	// Changed from a client-computed "Month Year" (derived from the FiscalPeriod/FiscalYear filter
	// values) to appending the backend-supplied HeaderText field instead - HeaderText comes from the
	// first row of the table's own data (see _getFirstRowHeaderText / the "dataReceived" handler in
	// onBeforeRebindTable), since the user wants the title driven by that field rather than recomputed
	// on the frontend from filter values.
	function buildTitleText(sHeaderText) {
		if (!sHeaderText) {
			return null;
		}

		return "Management Report for the Academic Year " + sHeaderText;
	}

	return ControllerExtension.extend("zcor001.ext.controller.ListReportExt", {
		// Creates the "localExt" model (exportEnabled defaulting to false) as early as onInit instead of
		// lazily inside onBeforeRebindTable, so that a "{localExt>/exportEnabled}" binding on the Export to
		// Excel button always resolves to false (rather than falling back to enabled) before the first "Go".
		override: {
			onInit: function () {
				var oView = this.base.getView();
				if (!oView.getModel("localExt")) {
					oView.setModel(new JSONModel({ exportEnabled: false, freezeStatus: "-" }), "localExt");
				}
			}
		},

		// Wired via manifest.json's tableSettings.beforeRebindTable (the OData V4 extension point for
		// reacting to a table rebind) - NOT nested under "override", since this is not one of the
		// documented ListReportController overrides (onAfterClear/onPendingFilters/onViewNeedsRefresh).
		// Runs on every "Go": freezes the leading column, hides the "Currency" column, refreshes the page
		// title/table header/column labels, enables the Export to Excel button once rows are loaded, and
		// shows a notice when background processing is selected.
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
				// Export to Excel should only be pressable once the table actually has rows. The real row
				// count isn't known yet at onBeforeRebindTable time (the rebind hasn't fetched data yet), so
				// exportEnabled is set from the "dataReceived" event of the table's own row-collection
				// binding (exposed here as "collectionBindingInfo").
				var oCollectionBindingInfo = oEvent.getParameter && oEvent.getParameter("collectionBindingInfo");
				if (oCollectionBindingInfo && oCollectionBindingInfo.attachEvent) {
					oCollectionBindingInfo.attachEvent("dataReceived", function (oDataEvent) {
						var oBinding = oDataEvent.getSource();
						var bHasError = !!oDataEvent.getParameter("error");
						var iLength = (!bHasError && oBinding && oBinding.getLength) ? oBinding.getLength() : 0;
						oLocalExtModel.setProperty("/exportEnabled", iLength > 0);

						// The report title's "Academic Year ..." suffix now comes from the HeaderText field
						// on the first loaded row (per user request), not from the filter bar - so it can only
						// be read here, once data has actually arrived, not earlier in onBeforeRebindTable.
						var sHeaderText = (!bHasError) ? this._getFirstRowHeaderText(oBinding) : undefined;
						this._updatePageTitle(sHeaderText);
						this._updateTableHeader(oTable, sHeaderText);

					}.bind(this));
				}

				this._freezeLeadingColumns(oTable, 1, oLocalExtModel);
				this._hideCurrencyColumn(oTable);
				// Bolds whole rows whose NodeStyle field is "BOLD" (hierarchy total/subtotal lines) -
				// see _applyNodeStyleBoldRows for why this needs the inner GridTable instance.
				this._applyNodeStyleBoldRows(oTable);


				StateUtil.retrieveExternalState(oFilterBar).then(function (oFilterState) {
					var mConditions = (oFilterState && oFilterState.filter) || {};
					var sFiscalPeriod = getConditionValue(mConditions, "FiscalPeriod");
					var sFiscalYear = getConditionValue(mConditions, "FiscalYear");
					var sComparisonYear = getConditionValue(mConditions, "ComparisonYear");

					this._updateRAmountColumnLabels(oTable, sFiscalPeriod);

					// CAmount01-12 column headers show the comparison year, not the fiscal year: they fall
					// back to FiscalYear - 1 only when the Comparison Year filter is left empty.
					this._updateComparisonYearColumnLabels(oTable, sComparisonYear, sFiscalYear);
					this._updateBudgetYearColumnLabels(oTable, sFiscalYear);


					// Shows an informational notice every time "Go" is pressed while ProcessingType = "B"
					// (background processing) is selected. Done here on the frontend rather than in the
					// query provider (zcl_co_zcor001_rpt) because IF_RAP_QUERY_RESPONSE has no method to
					// attach an informational message to an otherwise-successful response.
					var sProcessingType = getConditionValue(mConditions, "ProcessingType");
					if (sProcessingType === "B") {
						MessageBox.information("Background process has been processing");
					}

				}.bind(this)).catch(function (oError) {
					// eslint-disable-next-line no-console
					console.error("[ListReportExt] retrieveExternalState failed:", oError);
				});
			} catch (oError) {
				// eslint-disable-next-line no-console
				console.error("[ListReportExt] onBeforeRebindTable failed:", oError);
			}
		},

		// Now takes sHeaderText (the first row's HeaderText field) instead of sFiscalPeriod/sFiscalYear -
		// see buildTitleText and the "dataReceived" handler in onBeforeRebindTable for why.
		_updatePageTitle: function (sHeaderText) {
			var sTitleText = buildTitleText(sHeaderText);

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
		// page-level DynamicPageTitle) and disables the automatic "(N)" row-count suffix. Now takes
		// sHeaderText (the first row's HeaderText field) instead of sFiscalPeriod/sFiscalYear - see
		// buildTitleText and the "dataReceived" handler in onBeforeRebindTable for why.
		_updateTableHeader: function (oTable, sHeaderText) {
			var sTitleText = buildTitleText(sHeaderText);

			if (!sTitleText || !oTable || !oTable.setHeader) {
				return;
			}

			oTable.setHeader(sTitleText);

			if (oTable.setShowRowCount) {
				oTable.setShowRowCount(false);
			}
		},

		// Reads the HeaderText field off the first row of the table's row-collection binding. HeaderText
		// is not one of the LineItem's own visible columns, so it must be pulled into the table's own
		// $select the same way NodeStyle is (see manifest.json's NodeStyleHelperColumn "properties" list) -
		// otherwise getProperty("HeaderText") below would always return undefined, same class of issue
		// _applyNodeStyleBoldRows already documents for NodeStyle.
		_getFirstRowHeaderText: function (oBinding) {
			if (!oBinding || typeof oBinding.getContexts !== "function") {
				return undefined;
			}

			var aContexts = oBinding.getContexts(0, 1);
			var oFirstContext = aContexts && aContexts[0];

			return oFirstContext ? oFirstContext.getProperty("HeaderText") : undefined;
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


		// sap.ui.mdc.Table (type "GridTable") has no public/documented way to style a row from its own
		// data - the only documented per-row hook is the "rowSettings" aggregation's semantic
		// "highlight" color bar, not font weight. So this reaches into the inner sap.ui.table.Table
		// instance the mdc.Table wraps (its private "_oTable"), the same class of internal-API reach
		// _freezeLeadingColumns above already does via sap/ui/mdc/table/utils/Personalization. If a
		// future SAPUI5 upgrade renames/removes "_oTable", every step here is feature-detected and
		// wrapped in try/catch so bold styling is simply skipped rather than breaking the table.
		//
		// The listener is attached once per inner table instance (not once per "Go", since
		// onBeforeRebindTable re-runs on every "Go" but the inner table instance is reused) and reapplies
		// the CSS class on every "rowsUpdated" - the event sap.ui.table.Table fires whenever its
		// virtualized row set is re-rendered (initial load, scroll, sort, filter), since rows get reused
		// for different data and a previously-applied class would otherwise end up on the wrong row.

		// Previously used oRow.getDomRefs() and toggled the class on whatever jQuery-wrapped parts it
		// returned - that is guesswork about sap.ui.table.Row's private DOM structure, and evidently
		// never matched (no bold ever appeared). oRow.getCells() is the public, documented API that
		// returns the actual cell Controls for the row (in "rows" aggregation order), and every UI5
		// Control supports addStyleClass()/removeStyleClass() - both fully public, so this no longer
			// depends on any private structure at all.
		_setRowBoldClass: function (oRow, bBold) {
			var aCells = (typeof oRow.getCells === "function") ? oRow.getCells() : [];

			aCells.forEach(function (oCellControl) {
				if (!oCellControl || typeof oCellControl.addStyleClass !== "function") {
					return;
				}
				if (bBold) {
					oCellControl.addStyleClass(NODE_STYLE_BOLD_CSS_CLASS);
				} else {
					oCellControl.removeStyleClass(NODE_STYLE_BOLD_CSS_CLASS);
				}
			});
		},


		_applyNodeStyleBoldRows: function (oTable) {
			try {
				var oInnerTable = oTable && oTable._oTable;

				if (!oInnerTable || typeof oInnerTable.attachEvent !== "function" || typeof oInnerTable.getRows !== "function") {
					// eslint-disable-next-line no-console
					console.warn("[ListReportExt] _applyNodeStyleBoldRows: inner GridTable (_oTable) not found - bold styling skipped.");
					return;
				}

				if (oInnerTable._zcor001NodeStyleBoldAttached) {
					return;
				}
				oInnerTable._zcor001NodeStyleBoldAttached = true;

				var that = this;
				oInnerTable.attachEvent("rowsUpdated", function () {
					oInnerTable.getRows().forEach(function (oRow) {
						var oContext = oRow.getBindingContext();

						if (!oContext) {
							return;
						}

	
						// NodeStyle is not one of the LineItem's own visible columns, so plain
						// oContext.getProperty("NodeStyle") always returned undefined - the reason the
						// first version of this method never actually bolded anything. Context#
						// requestProperty() (OData V4's "late property" API, tried next) does not work
						// either: this entity's backend is a custom RAP query provider that only
						// implements "Read List", not "Read by Key", so the per-row single-entity GET it
						// issues is rejected outright. The only path left is making NodeStyle part of the
						// SAME list query as everything else - done via the technical, near-invisible
						// "NodeStyleHelperColumn" added in manifest.json (controlConfiguration ->
						// @com.sap.vocabularies.UI.v1.LineItem -> columns), whose "properties": ["NodeStyle"]
						// pulls it into the table's own $select. With that in place NodeStyle is already
						// loaded on every row's context by the time rowsUpdated fires, so a plain,
						// synchronous getProperty() is enough again.
						var bBold = oContext.getProperty("NodeStyle") === NODE_STYLE_BOLD_VALUE;
						that._setRowBoldClass(oRow, bBold);

					});
				});
			} catch (oError) {
				// eslint-disable-next-line no-console
				console.error("[ListReportExt] _applyNodeStyleBoldRows failed:", oError);
			}
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


		// CAmount01-12 columns show the comparison side of the report, so their "MONTH YYYY" header must
		// track the Comparison Year filter, not the Fiscal Year filter. When Comparison Year is left empty,
		// FiscalYear - 1 is used instead so the header still shows a sensible (prior fiscal year) label.
		_updateComparisonYearColumnLabels: function (oTable, sComparisonYear, sFiscalYear) {
			var iBaseYear = parseInt(sComparisonYear, 10);

			if (isNaN(iBaseYear)) {
				var iFiscalYear = parseInt(sFiscalYear, 10);

				if (isNaN(iFiscalYear)) {
					return;
				}

				iBaseYear = iFiscalYear - 1;
			}

			this._setCalendarYearColumnLabels(oTable, /^CAmount(\d{2})$/, iBaseYear);
		},



		// RBAmount01-12 columns keep following the Fiscal Year filter as before - only the CAmount01-12
		// columns above were changed to follow Comparison Year.
		_updateBudgetYearColumnLabels: function (oTable, sFiscalYear) {
			var iBaseYear = parseInt(sFiscalYear, 10);

			if (isNaN(iBaseYear)) {
				return;
			}

			this._setCalendarYearColumnLabels(oTable, /^RBAmount(\d{2})$/, iBaseYear);
		},

		// Shared header-setting logic: iBaseYear is the calendar year that fiscal period 1 (August) falls
		// in - periods 6-12 (Jan-Jul) roll into iBaseYear + 1.
		_setCalendarYearColumnLabels: function (oTable, rPropertyKeyPattern, iBaseYear) {
			var oColumns = (oTable && oTable.getColumns) ? oTable.getColumns() : [];

			oColumns.forEach(function (oColumn) {
				var sPropertyKey = oColumn.getPropertyKey ? oColumn.getPropertyKey() : oColumn.getProperty("propertyKey");
				var oMatch = sPropertyKey && rPropertyKeyPattern.exec(sPropertyKey);

				if (!oMatch || !oColumn.setHeader) {
					return;
				}

				var iColumnPeriod = parseInt(oMatch[1], 10);
				var sMonth = FISCAL_MONTHS[iColumnPeriod - 1].toUpperCase();
				var iCalendarYear = iColumnPeriod <= 5 ? iBaseYear : iBaseYear + 1;

				oColumn.setHeader(sMonth + " " + iCalendarYear);
			});
		},


		// Header action bound from manifest.json's ApplicationLogAction (positioned before
		// ExportToExcelAction). Always pressable, even before "Go" is pressed - unlike Export to Excel it
		// has no "enabled" binding, so it is never gated by localExt>/exportEnabled or table row count.
		// Navigates to the separate "Application Log" Fiori app (semantic object "zcoapplog", action
		// "display") via the standard sap.ushell CrossApplicationNavigation service rather than a
		// hardcoded URL, so the target app's real URL/routing is resolved by the Fiori Launchpad
		// regardless of environment.
		//
		// zcoapplog's ApplicationLog list report exposes Guid/Application/ExpUser as its filter bar's
		// SelectionFields. Passing Application and ExpUser as navigation parameters below pre-fills those
		// two filter fields and - per Fiori elements' documented behavior for navigation-parameter prefill -
		// triggers the initial search automatically, so the user lands on zcoapplog already showing "their
		// own log entries for this app" without pressing Go.
		onApplicationLog: function () {
			var oView = this.base.getView();
			var oResourceBundle = oView.getModel("i18n").getResourceBundle();

			// Chain now starts with _clearAllFiltersForAppLogNav() (test fix): pressing "Back" from the
			// Application Log app restored the old filters and re-ran "Go" automatically, which made the
			// backend create the background file again and showed the popup again. Clearing all filters
			// BEFORE navigating means the saved app state holds empty filters, so nothing re-runs on "Back".
			this._clearAllFiltersForAppLogNav().then(function () {
				return sap.ushell.Container.getServiceAsync("UserInfo");
			}).then(function (oUserInfo) {
				return oUserInfo.getId();

			}).catch(function () {
				// UserInfo lookup failing should not block the navigation itself - fall back to no ExpUser filter.
				return "";
			}).then(function (sUserId) {
				return sap.ushell.Container.getServiceAsync("CrossApplicationNavigation").then(function (oCrossAppNavigator) {
					var mParams = { Application: [ZCOAPPLOG_APPLICATION_ID] };
					if (sUserId) {
						mParams.ExpUser = [sUserId];
					}

					oCrossAppNavigator.toExternal({
						target: {
							semanticObject: ZCOAPPLOG_SEMANTIC_OBJECT,
							action: ZCOAPPLOG_ACTION
						},
						params: mParams
					});
				});
			}).catch(function (oError) {
				// eslint-disable-next-line no-console
				console.error("[ListReportExt] onApplicationLog failed:", oError);
				MessageBox.error(oResourceBundle.getText("applicationLogNavFailedMsg"));
			});
		},

		// Clears every Filter Bar condition, then waits for Fiori elements to store the new (empty) app
		// state, before onApplicationLog navigates away.
		// - Clearing uses StateUtil.applyExternalState with "filtered: false" on each existing condition -
		//   the documented mdc way to remove conditions (same Engine facade _hideCurrencyColumn uses).
		// - updateAppState() is awaited explicitly because Fiori elements otherwise saves app state
		//   asynchronously after a filter change; navigating before that finishes would still save the
		//   OLD filters and "Back" would re-run them anyway.
		// Never rejects: if clearing fails the navigation still goes ahead (only the re-run isn't prevented).
		_clearAllFiltersForAppLogNav: function () {
			var oView = this.base.getView();
			var oFilterBar = findFilterBar(oView, findMdcTable(oView));
			var oExtensionAPI = this.base.getExtensionAPI();

			if (!oFilterBar) {
				return Promise.resolve();
			}

			return StateUtil.retrieveExternalState(oFilterBar).then(function (oFilterState) {
				var mConditions = (oFilterState && oFilterState.filter) || {};
				var mRemoveConditions = {};

				Object.keys(mConditions).forEach(function (sProperty) {
					mRemoveConditions[sProperty] = (mConditions[sProperty] || []).map(function (oCondition) {
						return Object.assign({}, oCondition, { filtered: false });
					});
				});

				return StateUtil.applyExternalState(oFilterBar, { filter: mRemoveConditions });
			}).then(function () {
				return (oExtensionAPI && typeof oExtensionAPI.updateAppState === "function")
					? oExtensionAPI.updateAppState()
					: undefined;
			}).catch(function (oError) {
				// eslint-disable-next-line no-console
				console.error("[ListReportExt] _clearAllFiltersForAppLogNav failed:", oError);
			});
		},

		// Header action bound from manifest.json ("press": ".extension.zcor001.ext.controller.ListReportExt.onExportToExcel").
		// Reads the current Filter Bar state, calls the exportToExcel action, then - for the synchronous
		// "Online" processing type only - decodes the file content the action returns and downloads it.
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

					Object.keys(mParams).forEach(function (sParamName) {
						oActionBinding.setParameter(sParamName, mParams[sParamName]);
					});

					return oActionBinding.execute().then(function () {
						return oActionBinding.getBoundContext().requestObject();
					});
				}).then(function (oResult) {
					var sGuid = pickValue(oResult, GUID_RESULT_KEYS);
					var sFileName = pickValue(oResult, FILE_NAME_RESULT_KEYS);
					var sContent = pickValue(oResult, CONTENT_RESULT_KEYS);

					if (isZeroGuid(sGuid)) {
						throw new Error("ZERO_GUID");
					}

					// file_content is only populated for the synchronous "Online" processing type - the
					// backend skips generating it for "Background", where the user instead retrieves the
					// finished file later from the separate Application Log app. Downloading is therefore
					// conditional on content actually being present, not just on a non-zero guid.
					if (sContent) {
						downloadExportFile(sContent, sFileName);
					}
				}).then(function () {
					BusyIndicator.hide();
				}).catch(function (oError) {
					BusyIndicator.hide();
					// eslint-disable-next-line no-console
					console.error("[ListReportExt] onExportToExcel failed:", oError);

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

sap.ui.require(
    [
        'sap/fe/test/JourneyRunner',
        'zcor001/test/integration/FirstJourney',
		'zcor001/test/integration/pages/ManagementReportComparisionList',
		'zcor001/test/integration/pages/ManagementReportComparisionObjectPage'
    ],
    function(JourneyRunner, opaJourney, ManagementReportComparisionList, ManagementReportComparisionObjectPage) {
        'use strict';
        var JourneyRunner = new JourneyRunner({
            // start index.html in web folder
            launchUrl: sap.ui.require.toUrl('zcor001') + '/index.html'
        });

       
        JourneyRunner.run(
            {
                pages: { 
					onTheManagementReportComparisionList: ManagementReportComparisionList,
					onTheManagementReportComparisionObjectPage: ManagementReportComparisionObjectPage
                }
            },
            opaJourney.run
        );
    }
);
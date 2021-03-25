// #import SiteBuilder
// #import TestKit
'use strict';

JSClass('SiteBuilderTests', TKTestSuite, {

    testExample: function(){
        var x = 1;
        var y = 2;
        TKAssertEquals(x, 1);
        TKAssertEquals(y, 2);
    }

});
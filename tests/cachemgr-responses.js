// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// check that cache manager responses are not cached

import assert from "assert";
import * as Config from "../src/misc/Config";
import Authority from "../src/anyp/Authority";
import HttpTestCase from "../src/test/HttpCase";
import Test from "../src/overlord/Test";

export default class MyTest extends Test {

    constructor() {
        super(...arguments);

        this._skip = ['index', 'shutdown', 'reconfigure'];
    }

    _configureDut(cfg) {
        // disable password for private pages
        cfg.custom('cachemgr_passwd none offline_toggle');
        cfg.custom('cachemgr_passwd none shutdown');
        cfg.custom('cachemgr_passwd none reconfigure');
        cfg.custom('cachemgr_passwd none rotate');
        cfg.custom('cachemgr_passwd none config');
    }

    async testMenu(name, description) {
        const testCase = new HttpTestCase(description);
        testCase.client().request.startLine.uri.relative = true;
        testCase.client().request.startLine.uri.path = `/squid-internal-mgr/${name}`;
        testCase.client().request.startLine.uri.authority = Authority.FromHostPort(Config.ProxyAuthority);

        testCase.check(() => {
            const response = testCase.client().transaction().response;
            const field = testCase.client().transaction().response.header.value("Cache-Status");
            testCase.expectStatusCode(200);
            assert(!field.toLowerCase().includes('hit'));
        });

        await testCase.run();
    }

    async run(/*testRun*/) {
        const menuPages = await this.dut.getCacheManagerMenu();
        console.log(menuPages);
        for (let page of menuPages) {
            if (this._skip.includes(page)) {
                console.log("Skipping: " + page);
                continue;
            }
            await this.testMenu(page, `attempt to cache ${page} Cache Manager response`);
            await this.testMenu(page, `check that ${page} Cache Manager response is not cached`);
        }
    }
}


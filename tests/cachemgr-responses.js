// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// check that cache manager responses are not cached

import assert from "assert";
import * as Config from "../src/misc/Config";
import Authority from "../src/anyp/Authority";
import HttpTestCase from "../src/test/HttpCase";
import Test from "../src/overlord/Test";
import { FlexibleConfigGen } from "../src/test/ConfigGen";

Config.Recognize([
    {
        option: "workers",
        type: "Number",
        description: "the number of Squid worker processes",
    },
    {
        option: "pages",
        type: "String",
        enum: ["public", "hidden"],
        description: `group of pages: 'public': withhout password protection, 'hidden': with password protection`,
    },
]);

export default class MyTest extends Test {

    constructor() {
        super(...arguments);

        this._skip = ['index', 'shutdown', 'reconfigure', 'rotate', 'offline_toggle'];
    }
    static Configurators() {
        const configGen = new FlexibleConfigGen();

        configGen.workers(function *() {
            yield 1;
            yield 4;
        });

        configGen.pages(function *() {
            yield "public";
            yield "hidden";
        });

        configGen.dutMemoryCache(function *() {
            yield false;
            yield true;
        });

        configGen.dutDiskCache(function *(cfg) {
            if (cfg.dutMemoryCache()) // do not end up with no caching at all
                yield false;
            yield true;
        });

        return configGen.generateConfigurators();
    }

    _configureDut(cfg) {
        if (Config.Pages === "public")
            cfg.custom('cachemgr_passwd none all');
        cfg.workers(Config.workers()); // TODO: This should be the default.
    }

    async testMenu(name, description) {
        const testCase = new HttpTestCase(description);
        testCase.client().request.startLine.uri.relative = true;
        testCase.client().request.startLine.uri.path = `/squid-internal-mgr/${name}`;
        testCase.client().request.startLine.uri.authority = Authority.FromHostPort(Config.ProxyAuthority);

        testCase.check(() => {
            const response = testCase.client().transaction().response;
            let field = null;
            if (response.header.has("Cache-Status"))
                field = response.header.value("Cache-Status");
            testCase.expectStatusCode(200);
            assert(!field || !field.toLowerCase().includes('hit'));
        });

        await testCase.run();
    }

    async testHiddenPage(name, description) {
        const testCase = new HttpTestCase(description);
        testCase.client().request.startLine.uri.relative = true;
        testCase.client().request.startLine.uri.path = `/squid-internal-mgr/${name}`;
        testCase.client().request.startLine.uri.authority = Authority.FromHostPort(Config.ProxyAuthority);

        testCase.check(() => {
            testCase.expectStatusCode(404);
        });

        await testCase.run();
    }

    async run(/*testRun*/) {
        const menuPages = await this.dut.getCacheManagerMenu();

        // Squid may also mark pages as 'disabled' or 'protected'.
        // for other cachemgr_passwd configurations.
        // TODO: test these configurations.
        if (Config.Pages === "public")
            assert(menuPages.every(p => p.protection === "public")); // all pages are forced to be 'public'
        if (Config.Pages === "hidden")
            assert(menuPages.some(p => p.protection === "hidden"));

        for (let page of menuPages) {
            if (this._skip.includes(page.name)) {
                console.log("Skipping: " + page.name);
                continue;
            }
            if (Config.Pages === "public") {
                await this.testMenu(page.name, `attempt to cache ${page.name} Cache Manager response`);
                await this.testMenu(page.name, `check that ${page.name} Cache Manager response is not cached`);
            } else {
                assert(Config.Pages === "hidden");
                if (page.protection === "public")
                    continue;
                assert(page.protection === "hidden");
                await this.testHiddenPage(page.name, `check that the ${page.name} hidden Cache Manager page is not available`);
            }
        }
    }
}


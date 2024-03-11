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
        option: "poke-same-worker",
        type: "Boolean",
        description: "send all test case requests to the same Squid worker process",
    },
    {
        option: "pages",
        type: "String",
        enum: ["all", "hidden"],
        default: "all",
        description: "specify the pages to test",
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
            yield "all";
            yield "hidden";
        });

        configGen.pokeSameWorker(function *(cfg) {
            if (cfg.workers() > 1) // poking different workers requires multiple workers
                yield false;
            yield true;
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
        if (Config.Pages === "all")
            cfg.custom('cachemgr_passwd none all');
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
        console.log(menuPages);
        for (let page of menuPages) {
            if (this._skip.includes(page)) {
                console.log("Skipping: " + page);
                continue;
            }
            if (Config.Pages === "all") {
                await this.testMenu(page, `attempt to cache ${page} Cache Manager response`);
                await this.testMenu(page, `check that ${page} Cache Manager response is not cached`);
            } else {
                const page = "config";
                await this.testHiddenPage(page, `check that the ${page} hidden Cache Manager page is not available`);
            }
        }
    }
}


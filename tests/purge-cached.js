// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests purging of a response cached on disk, including across a DUT restart.
// TODO: Test memory caching (without restarting the DUT).

import assert from "assert";
import { FlexibleConfigGen } from "../src/test/ConfigGen.js";
import Config from "../src/misc/Config.js";
import HttpTestCase from "../src/test/HttpCase.js";
import Resource from "../src/anyp/Resource.js";
import Test from "../src/overlord/Test.js";

Config.Recognize([
    {
        option: "workers",
        type: "Number",
        description: "the number of Squid worker processes",
    },
    {
        // A DELETE should have both immediate (i.e. before restart) and
        // lasting (i.e. after restart) effects. However, checking the effects
        // of DELETE before the restart may mask a problem with flushing
        // metadata to disk, so we do not want to always perform that check.
        option: "check-before-restart",
        type: "Boolean",
        description: "whether to check purging results before restarting Squid",
    },
    {
        option: "create-background-load",
        type: "Boolean",
        description: "whether to use background transactions to increase test pressure",
    },
]);

export default class MyTest extends Test {

    static Configurators() {
        const configGen = new FlexibleConfigGen();

        configGen.workers(function *() {
            yield 0; // to test without disker
            yield 1;
            yield 4;
        });

        configGen.dutDiskCache(function *() {
            yield true;
        });

        configGen.checkBeforeRestart(function *() {
            yield false;
            yield true;
        });

        configGen.createBackgroundLoad(function *(cfg) {
            yield false;
            if (cfg.workers() === 1) // just to reduce the total number of tests
                yield true;
        });

        return configGen.generateConfigurators();
    }

    _configureDut(cfg) {
        cfg.workers(Config.workers()); // TODO: This should be the default.
    }

    async run(/*testRun*/) {
        this._resource = new Resource();
        this._resource.makeCachable();
        this._resource.finalize();

        await this._fillCache(`cache`);

        const backgroundLoadRuns = Config.createBackgroundLoad() ? this._createBackgroundLoad() : null;

        await this._purgeCachedResponse(`purge the cached response`);
        if (Config.checkBeforeRestart())
            await this._checkPurging(`check cached response was purged (before restart)`);

        await this.dut.restart();
        await backgroundLoadRuns; // may be null

        await this._checkPurging(`check the cached response remains purged after restart`);

        await this._fillCache(`re-cache`);

        await this._purgeCachedResponse(`purge the re-cached response`);
        await this._checkPurging(`check the re-cached response was purged`);
    }

    async _fillCache(action) {
        assert(action === "cache" || action === "re-cache");

        const caseFill = new HttpTestCase(`${action} a response`);
        caseFill.server().serve(this._resource);
        caseFill.client().request.for(this._resource);
        caseFill.addMissCheck();
        await caseFill.run();

        await this.dut.finishCaching();

        const caseHit = new HttpTestCase(`hit the ${action}d response`);
        caseHit.client().request.for(this._resource);
        caseHit.client().request.header.add("Cache-Control", "only-if-cached");
        caseHit.addHitCheck(caseFill.server().transaction().response);
        await caseHit.run();
    }

    async _purgeCachedResponse(testCaseTitle) {
        const casePurgeCached = new HttpTestCase(testCaseTitle);
        casePurgeCached.server().serve(this._resource);
        casePurgeCached.client().request.for(this._resource);
        casePurgeCached.client().request.startLine.method = 'DELETE';
        casePurgeCached.addMissCheck();
        await casePurgeCached.run();
    }

    async _checkPurging(testCaseTitle) {
        const caseCheckPurged = new HttpTestCase(testCaseTitle);
        caseCheckPurged.client().request.for(this._resource);
        caseCheckPurged.client().request.header.add("Cache-Control", "only-if-cached");
        caseCheckPurged.client().checks.add(client => client.expectStatusCode(504));
        await caseCheckPurged.run();
    }

    async _createBackgroundLoad() {
        // TODO: Instead of just starting 100 test cases, keep starting new
        // cases to maintain 100 concurrent cases until this.dut.restart().
        const loadCaseRuns = [];
        for (var i = 0; i < 100; ++i) {
            const caseHitLoad = new HttpTestCase(`hit the cached response in the background (${i})`);
            caseHitLoad.client().request.for(this._resource);
            // no caseHitLoad.addHitCheck() here because we want some of these
            // transactions to run across Squid restart below
            caseHitLoad.client().request.header.add("Cache-Control", "only-if-cached");
            loadCaseRuns.push(caseHitLoad.run());
        }
        await Promise.all(loadCaseRuns);
    }

}

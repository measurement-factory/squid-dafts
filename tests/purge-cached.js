// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests purging of a response cached on disk, including across a DUT restart.
// TODO: Test memory caching (without restarting the DUT).

import * as Config from "../src/misc/Config";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import Test from "../src/overlord/Test";
import { FlexibleConfigGen } from "../src/test/ConfigGen";

Config.Recognize([
    {
        option: "workers",
        type: "Number",
        description: "the number of Squid worker processes",
    },
]);

export default class MyTest extends Test {

    static Configurators() {
        const configGen = new FlexibleConfigGen();

        configGen.workers(function *() {
            yield 0;
            yield 1;
            yield 4;
        });

        configGen.dutDiskCache(function *(cfg) {
            yield true;
        });

        return configGen.generateConfigurators();
    }

    _configureDut(cfg) {
        cfg.workers(Config.workers()); // TODO: This should be the default.
    }

    async run(/*testRun*/) {
        const resource = new Resource();
        resource.makeCachable();
        resource.finalize();

        const caseFillCache = new HttpTestCase(`cache a response`);
        caseFillCache.server().serve(resource);
        caseFillCache.client().request.for(resource);
        caseFillCache.addMissCheck();
        await caseFillCache.run();

        await this.dut.finishCaching();

        const caseHitBeforeRestart = new HttpTestCase(`hit the cached response`);
        caseHitBeforeRestart.client().request.for(resource);
        caseHitBeforeRestart.addHitCheck(caseFillCache.server().transaction().response);
        await caseHitBeforeRestart.run();

        const casePurge = new HttpTestCase(`purge cached response`);
        casePurge.server().serve(resource);
        casePurge.client().request.for(resource);
        casePurge.client().request.startLine.method = 'DELETE';
        casePurge.addMissCheck();
        await casePurge.run();

        const caseCheckPurgedBeforeRestart = new HttpTestCase(`check cached response was purged`);
        caseCheckPurgedBeforeRestart.client().request.for(resource);
        caseCheckPurgedBeforeRestart.client().request.header.add("Cache-Control", "only-if-cached");
        caseCheckPurgedBeforeRestart.client().checks.add(client => client.expectStatusCode(504));
        await caseCheckPurgedBeforeRestart.run();

        await this.dut.restart();

        // Side effect (used by caseHitAfterRestart): This test case caches the response again.
        const caseCheckPurgedAfterRestart = new HttpTestCase(`check cached response remains purged after restart`);
        caseCheckPurgedAfterRestart.server().serve(resource);
        caseCheckPurgedAfterRestart.client().request.for(resource);
        caseCheckPurgedAfterRestart.addMissCheck();
        await caseCheckPurgedAfterRestart.run();

        await this.dut.finishCaching();

        const caseHitAfterRestart = new HttpTestCase(`hit the re-cached response`);
        caseHitAfterRestart.client().request.for(resource);
        caseHitAfterRestart.addHitCheck(caseCheckPurgedAfterRestart.server().transaction().response);
        await caseHitAfterRestart.run();
    }
}

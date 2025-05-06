// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// This test fills a small cache with objects and then checks
// that new hits are still possible.

import assert from "assert";
import HttpTestCase from "../src/test/HttpCase";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import * as Config from "../src/misc/Config";
import * as AddressPool from "../src/misc/AddressPool";
import Test from "../src/overlord/Test";
import ConfigGen from "../src/test/ConfigGen";


const CacheSize = 1; // MB
const ResponseBodyBytes = 1024 * 100;

const ExpectedCapacity = Math.round(1024*1024*CacheSize/ResponseBodyBytes);
// TODO: make configurable
const MinimumHits = ExpectedCapacity/2+1;

Config.Recognize([
    {
        option: "cache-type",
        type: "String",
        enum: ["mem", "disk"],
        description: "Turns on rock disk cache",
    },
    {
        option: "smp",
        type: "Boolean",
        default: "false",
        description: "In this mode MISS and HIT requests will go to different proxy SMP workers",
    },
]);

export default class MyTest extends Test {

    constructor(...args) {
        super(...args);
        // 1. cache this URL at the beginning
        // 2. refill the cache and expect this entry to be purged due to key collision
        // 3. request this URL again and expect a miss
        this.cachedUrl = null;
    }

    _configureDut(cfg) {

        if (Config.CacheType === 'disk')
            cfg.diskCaching(true, `${CacheSize}`);
        else 
            cfg.memoryCaching(true,  `${CacheSize} MB`);

        if (Config.Smp) {
            cfg.workers(4);
            cfg.dedicatedWorkerPorts(true);
            this._workerListeningAddresses = cfg.workerListeningAddresses();
        }
    }

    static Configurators() {
        const configGen = new ConfigGen();
        configGen.addGlobalConfigVariation({cacheType: ['mem', 'disk']});
        configGen.addGlobalConfigVariation({smp: [true, false]});
        return configGen.generateConfigurators();
    }

    async doMiss(resource, step, description) {
        let missCase = new HttpTestCase(`${description}: forward a ${ResponseBodyBytes}-byte response`);
        missCase.server().serve(resource);
        missCase.server().response.forceEof = Config.ResponseEndsAtEof;
        missCase.client().request.for(resource);
        if (Config.Smp)
            missCase.client().nextHopAddress = this._workerListeningAddresses[step];
        missCase.addMissCheck();
        await missCase.run();

        await this.dut.finishCaching();
        return missCase;
    }

    async doHit(resource, missCase, step, description) {
        let hitCase = new HttpTestCase(`${description}: hit a ${ResponseBodyBytes}-byte response`);
        hitCase.client().request.for(resource);
        if (Config.Smp)
            hitCase.client().nextHopAddress = this._workerListeningAddresses[step];
        hitCase.addHitCheck(missCase.server().transaction().response);
        try {
            await hitCase.run();
            return 1;
        } catch (ex) {
            const response = hitCase.client().transaction().response;
            assert(response.startLine.codeInteger() === 503);
        }
        return 0;
    }

    async testStep(step, description) {
        const address = AddressPool.ReserveListeningAddress();
        let hits = 0;
        for (let i = 0; i < ExpectedCapacity; ++i) {
            let resource = new Resource();
            resource.uri.address = address;
            resource.makeCachable();
            resource.body = new Body('x'.repeat(ResponseBodyBytes));
            resource.finalize();
            if (this.cachedUrl === null) {
                this.cachedUrl = resource.uri;
//                AddressPool.ReleaseListeningAddress(address);
//                return;
            }
            let missCase = await this.doMiss(resource, step, description);
            hits += await this.doHit(resource, missCase, step, description);
        }
        assert(hits >= MinimumHits, "expected hit ratio");
        AddressPool.ReleaseListeningAddress(address);
    }

    async testCachedUrlPurged() {
        const address = AddressPool.ReserveListeningAddress();
        assert(this.cachedUrl);
        let resource = new Resource();
        resource.uri.address = address;
        resource.uri = this.cachedUrl;
        resource.makeCachable();
        resource.body = new Body('x'.repeat(ResponseBodyBytes));
        resource.finalize();

        await this.doMiss(resource, 1, "test that the initially cached URL was purged");
        AddressPool.ReleaseListeningAddress(address);
    }

    async testAll() {
        const address = AddressPool.ReserveListeningAddress();
        await this.testStep(1, "Fill the cache");
        await this.testStep(2, "Overfill the cache");
        await this.testStep(3, "Check");
        await this.testCachedUrlPurged();
        AddressPool.ReleaseListeningAddress(address);
    }

    async run(/*testRun*/) {
        await this.testAll();
    }
}


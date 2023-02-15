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

    async testStep(step, description) {
        const address = AddressPool.ReserveListeningAddress();
        let hits = 0;
        for (let i = 0; i < ExpectedCapacity; ++i) {
            let resource = new Resource();
            resource.uri.address = address;
            resource.makeCachable();
            resource.body = new Body('x'.repeat(ResponseBodyBytes));
            resource.finalize();

            let missCase = new HttpTestCase(`${description}: forward a ${ResponseBodyBytes}-byte response`);
            missCase.server().serve(resource);
            missCase.server().response.forceEof = Config.ResponseEndsAtEof;
            missCase.client().request.for(resource);
            if (Config.Smp)
                missCase.client().nextHopAddress = this._workerListeningAddresses[step];
            missCase.addMissCheck();
            await missCase.run();

            await this.dut.finishCaching();

            let hitCase = new HttpTestCase(`${description}: hit a ${ResponseBodyBytes}-byte response`);
            hitCase.client().request.for(resource);
            if (Config.Smp)
                hitCase.client().nextHopAddress = this._workerListeningAddresses[step];

            hitCase.addHitCheck(missCase.server().transaction().response);

            try {
                await hitCase.run();
                hits++;
            } catch (ex) {
                const response = hitCase.client().transaction().response;
                assert(response.startLine.codeInteger() === 503);
            }
        }
        assert(hits >= MinimumHits, "expected hit ratio");
        AddressPool.ReleaseListeningAddress(address);
    }

    async testAll() {
        const address = AddressPool.ReserveListeningAddress();
        await this.testStep(1, "Fill the cache");
        await this.testStep(2, "Overfill the cache");
        await this.testStep(3, "Check");
        AddressPool.ReleaseListeningAddress(address);
    }

    async run(/*testRun*/) {
        await this.testAll();
    }
}


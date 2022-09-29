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

// TODO: make configurable
const Slots = 10;
const MinimumHits = Slots/2+1;

const DirSize = 1; // MB
const RockSlotSize = 100000; // bytes

const MemSlotSize = 4096; // bytes
const MemSizeBytes = MemSlotSize * Slots;

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
            cfg.custom(`cache_dir rock ${Config.CacheDirPath} ${DirSize} slot-size=${RockSlotSize}`);
        else 
            cfg.custom(`cache_mem ${MemSizeBytes} bytes`);

        if (Config.Smp) {
            cfg.workers(3);
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

    async testStep(step, minimumHits, description) {
        const address = AddressPool.ReserveListeningAddress();
        let hits = 0;
        for (let i = 0; i < Slots; ++i) {
            let resource = new Resource();
            resource.uri.address = address;
            resource.makeCachable();
            resource.body = new Body();
            resource.finalize();

            let missCase = new HttpTestCase(`${description}: forward a ${Config.BodySize}-byte response`);
            missCase.server().serve(resource);
            missCase.server().response.forceEof = Config.ResponseEndsAtEof;
            missCase.client().request.for(resource);
            if (Config.Smp)
                missCase.client().nextHopAddress = this._workerListeningAddresses[step];
            missCase.addMissCheck();
            await missCase.run();

            await this.dut.finishCaching();

            let hitCase = new HttpTestCase(`${description}: hit a ${Config.BodySize}-byte response`);
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
        assert(hits >= minimumHits, "expected hit ratio");
        AddressPool.ReleaseListeningAddress(address);
    }

    async testAll() {
        const address = AddressPool.ReserveListeningAddress();
        await this.testStep(1, Slots, "Fill the cache");
        await this.testStep(2, 0, "Overfill the cache");
        await this.testStep(3, MinimumHits, "Check");
        AddressPool.ReleaseListeningAddress(address);
    }

    async run(/*testRun*/) {
        await this.testAll();
    }
}


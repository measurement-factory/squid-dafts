// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests whether an HTTP proxy does not allow to increase an HTTP response header
// via 304 responses more than the specified limit.

import HttpTestCase from "../src/test/HttpCase";
import Field from "../src/http/Field";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import * as ConfigurationGenerator from "../src/test/ConfigGen";
import * as AddressPool from "../src/misc/AddressPool";
import * as FuzzyTime from "../src/misc/FuzzyTime";
import * as Gadgets from "../src/misc/Gadgets";
import * as Config from "../src/misc/Config";
import assert from "assert";
import Test from "../src/overlord/Test";

// TODO: make configurable
const MaxPrefixSize = 65536;

Config.Recognize([
    {
        option: "smp",
        type: "Boolean",
        default: "false",
        description: "In this mode MISS, UPDATE and HIT requests will go to different proxy SMP workers",
    },
    {
        option: "dut-cache",
        type: "String",
        enum: [ 'mem', 'disk', 'all' ],
        description: "Turns on rock disk cache",
    },
]);

export default class MyTest extends Test {

    _configureDut(cfg) {
        const memCache = Config.dutCache() === 'mem' || Config.dutCache() === 'all';
        const diskCache = Config.dutCache() === 'disk' || Config.dutCache() === 'all';
        cfg.memoryCaching(memCache || !Config.smp()); // always turn on memory cache in non-smp mode
        cfg.diskCaching(diskCache && Config.smp()); // turn on rock only in smp mode

        if (Config.smp()) {
            cfg.workers(4);
            cfg.dedicatedWorkerPorts(true);
            this._workerListeningAddresses = cfg.workerListeningAddresses();
        } 
    }

    static Configurators() {
        const configGen = new ConfigurationGenerator.FlexibleConfigGen();

        configGen.smp(function *(cfg) {
            yield false;
            yield true;
        });

        configGen.dutCache(function *(cfg) {
            yield "mem";
            if (cfg.smp()) {
                yield "disk";
                yield "all";
            }
        });
        
        return configGen.generateConfigurators();
    }

    async testOne() {

        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.modifiedAt(FuzzyTime.DistantPast());
        resource.expireAt(FuzzyTime.Soon());
        resource.finalize();

        // This header appears in the initially cached response.
        // This header does not appear in the updatingResponse.
        // This header must upppear in the updatedResponse.
        const hitCheck = new Field("X-Daft-Hit-Check", Gadgets.UniqueId("check"));

        const updateHeaderName = "X-Update-Header";
        let updateField = new Field(updateHeaderName, 'x');
        updateField.finalize();
        const updateHeaderLength = updateField.raw().length;
        
        {
            const prefixSize = MaxPrefixSize - updateHeaderLength;
            let testCase = new HttpTestCase(`forward a cachable response with a prefix size less than the maximum allowed prefix size ${prefixSize}<${MaxPrefixSize}`);
            testCase.client().request.for(resource);
            if (Config.smp())
                testCase.client().nextHopAddress = this._workerListeningAddresses[1];
            testCase.server().serve(resource);
            testCase.server().response.enforceMinimumPrefixSize(prefixSize);
            testCase.server().response.header.add(hitCheck);
            await testCase.run();
        }

        {
            let testCase = new HttpTestCase('respond with a 304 hit');
            testCase.client().request.for(resource);
            if (Config.smp())
                testCase.client().nextHopAddress = this._workerListeningAddresses[1];
            testCase.client().request.conditions({ ims: resource.notModifiedSince() });
            testCase.client().checks.add((client) => {
                client.expectStatusCode(304);
            });
            await testCase.run();
        }

        let updatingResponse = null;
        {
            let testCase = new HttpTestCase(`get a 304 that makes cached header size equal to the maximum allowed prefix size: ${MaxPrefixSize}`);

            resource.modifyNow();
            resource.expireAt(FuzzyTime.DistantFuture());

            testCase.client().request.for(resource);
            testCase.client().request.conditions({ ims: resource.modifiedSince() });
            testCase.client().request.header.add("Cache-Control", "max-age=0");
            if (Config.smp())
                testCase.client().nextHopAddress = this._workerListeningAddresses[2];

            testCase.server().response.header.add(updateField);
            testCase.server().response.startLine.code(304);
            testCase.server().serve(resource);
            testCase.check(() => {
                updatingResponse = testCase.server().transaction().response;
                const receivedResponse = testCase.client().transaction().response;
                assert(receivedResponse.startLine.codeInteger() === 200);
            });
            await testCase.run();
        }

        {
            let testCase = new HttpTestCase('hit updated headers');
            testCase.client().request.for(resource);
            if (Config.smp())
                testCase.client().nextHopAddress = this._workerListeningAddresses[3];
            testCase.check(() => {
                let updatedResponse = testCase.client().transaction().response;
                const code = updatedResponse.startLine.codeInteger();
                assert.equal(code, 200);
                assert.equal(updatingResponse.id(), updatedResponse.id(), "updated X-Daft-Response-ID");
                assert.equal(updatedResponse.header.values("Last-Modified"), resource.lastModificationTime.toUTCString(), "updated Last-Modified");
                assert.equal(updatedResponse.header.value(hitCheck.name), hitCheck.value, "preserved originally cached header field");
            });
            await testCase.run();
        }

        {
            let testCase = new HttpTestCase(`get a 304 that makes cached header size greater than the maximum allowed prefix size: ${MaxPrefixSize}+1`);

            resource.modifyNow();
            resource.expireAt(FuzzyTime.DistantFuture());

            testCase.client().request.for(resource);
            testCase.client().request.conditions({ ims: resource.modifiedSince() });
            testCase.client().request.header.add("Cache-Control", "max-age=0");
            if (Config.smp())
                testCase.client().nextHopAddress = this._workerListeningAddresses[2];

            testCase.server().response.header.addOverwrite(updateHeaderName, "xy");

            testCase.server().response.startLine.code(304);
            testCase.server().serve(resource);
            testCase.check(() => {
                const receivedResponse = testCase.client().transaction().response;
                assert(receivedResponse.startLine.codeInteger() >= 500);
            });
            await testCase.run();
        }

        {
            let testCase = new HttpTestCase('check that the proxy did not cache the entry with too big prefix');
            testCase.client().request.for(resource);
            if (Config.smp())
                testCase.client().nextHopAddress = this._workerListeningAddresses[3];
            testCase.check(() => {
                const updatedResponse = testCase.client().transaction().response;
                assert(updatedResponse.startLine.codeInteger() >= 500);
            });
            await testCase.run();
        }

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async run(/*testRun*/) {
        await this.testOne();
    }
}


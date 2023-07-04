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
const MaxHeaderSize = 65536;

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

    async testOne(headerSize, updateSuccess) {

        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.modifiedAt(FuzzyTime.DistantPast());
        resource.expireAt(FuzzyTime.Soon());
        resource.body = new Body("z".repeat(64));
        resource.finalize();

        // This header appears in the initially cached response.
        // This header does not appear in the updatingResponse.
        // This header must upppear in the updatedResponse.
        const hitCheck = new Field("X-Daft-Hit-Check", Gadgets.UniqueId("check"));

        let updateField = new Field("X-Update-Header", Gadgets.UniqueId("update"));
        updateField.finalize();
        const updateHeaderLength = updateField.raw().length;
        
        {
            let testCase = new HttpTestCase('forward a cachable response');
            testCase.client().request.for(resource);
            if (Config.smp())
                testCase.client().nextHopAddress = this._workerListeningAddresses[1];
            testCase.server().serve(resource);
            let startLine = testCase.server().response.startLine;
            startLine.finalize(); // 200 by default
            const headerSeparator = 2; // "\r\n"
            const finalPrefixSize = headerSize + startLine.raw().length + 2; // will become ofter receiving 304 updating response
            const initialPrefixSize = finalPrefixSize - updateHeaderLength;
            assert(initialPrefixSize <= MaxHeaderSize);
            testCase.server().response.enforceMinimumPrefixSize(initialPrefixSize);
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
            let testCase = new HttpTestCase(`get a 304 that increases the cached header size on ${updateHeaderLength}`);

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
                const receivedResponse = testCase.client().transaction().response;
                const code = receivedResponse.startLine.codeInteger();
                updatingResponse = testCase.server().transaction().response;
                if (headerSize <= MaxHeaderSize) {
                    assert.equal(updatingResponse.id(), receivedResponse.id(), "relayed X-Daft-Response-ID");
                    assert.equal(code, 200);
                } else {
                    assert(code>=500);
                }
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
                if (headerSize <= MaxHeaderSize) {
                    assert.equal(code, 200);
                    assert.equal(updatingResponse.id(), updatedResponse.id(), "updated X-Daft-Response-ID");
                    assert.equal(updatedResponse.header.values("Last-Modified"), resource.lastModificationTime.toUTCString(), "updated Last-Modified");
                    assert.equal(updatedResponse.header.value(hitCheck.name), hitCheck.value, "preserved originally cached header field");
                } else {
                    assert(code>=500);
                }
            });
            await testCase.run();
        }

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async run(/*testRun*/) {
        // TODO: test some other sizes?
        await this.testOne(MaxHeaderSize);
        await this.testOne(MaxHeaderSize+1);
    }
}


/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

/* Tests whether an HTTP proxy can "collapse"
 * revalidation requests */

import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import * as AddressPool from "../src/misc/AddressPool";
import * as FuzzyTime from "../src/misc/FuzzyTime";
import * as Gadgets from "../src/misc/Gadgets";
import * as Config from "../src/misc/Config";
import Test from "../src/overlord/Test";
import ConfigGen from "../src/test/ConfigGen";
import Field from "../src/http/Field";
import assert from "assert";

Config.Recognize([
    {
        option: "workers",
        type: "Number",
        default: "2",
        description: "number of clients",
    },
    {
        option: "collapsed-requests",
        type: "Number",
        default: "2",
        description: "the number of collapsed requests",
    },
    {
        option: "request-type",
        type: "String",
        enum: ["basic", "ims", "refresh", "auth"],
        description: "The proxy revalidation request type"
    },
    {
        option: "server-status",
        type: "Number",
        enum: [ "200", "304" ], // TODO: add 50x
        default: "0",
        description: "server response status code",
   },
   {
       option: "collapsed-threshold",
       type: "Number",
       default: "50",
       description: "the percentage of proxy revalidation requests that are expected to collapse",
   },
]);

export default class MyTest extends Test {
    _configureDut(cfg) {
        cfg.memoryCaching(true);
        cfg.diskCaching(false);
        cfg.collapsedForwarding(true);
        if (Config.Workers > 1) {
            cfg.workers(Config.Workers);
            cfg.dedicatedWorkerPorts(true);
            this._workerListeningAddresses = cfg.workerListeningAddresses();
        }
    }

    static Configurators() {
        const configGen = new ConfigGen();
        configGen.addGlobalConfigVariation({workers: ["1", "2"]});
        configGen.addGlobalConfigVariation({requestType: ["basic", "ims", "refresh", "auth"]});
        configGen.addGlobalConfigVariation({serverStatus: ["200", "304"]});
        return configGen.generateConfigurators();
    }

    async cacheSomething(resource, hitCheck) {
        let testCase = new HttpTestCase('forward a cachable response');
        testCase.client().request.for(resource);
        testCase.server().serve(resource);
        testCase.server().response.tag("cache");
        testCase.server().response.header.add(hitCheck);
        testCase.server().response.header.add("Cache-Control", "max-age=0");
        testCase.client().checks.add((client) => {
            client.expectStatusCode(200);
        });
        await testCase.run();
    }

    configureCollapsedRequest(request, resource) {
        request.for(resource);
        if (Config.RequestType === "auth")
            request.header.add("Authorization", "Basic dXNlcjpwYXNz"); // user:pass
        else if (Config.RequestType === "ims")
            request.conditions({ ims: resource.notModifiedSince() });
        else if (Config.RequestType === "refresh")
            request.header.add("Cache-Control", "max-age=0");
    }

    async checkOne()
    {
        const collapsedRequests = Number.parseInt(Config.CollapsedRequests, 10);
        const serverStatus = Number.parseInt(Config.ServerStatus, 10);
        const workers = Number.parseInt(Config.Workers, 10);
        const expectedClientStatus = (serverStatus === 304 && Config.RequestType === "ims") ? 304 : 200;
        const revalidationTag = "revalidation";

        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.modifiedAt(FuzzyTime.DistantPast());
        resource.finalize();

        const hitCheck = new Field("X-Daft-Hit-Check", Gadgets.UniqueId("check"));
        await this.cacheSomething(resource, hitCheck);

        let testCase = new HttpTestCase("send " + Config.CollapsedRequests + " requests to check collapsed revalidation");
        let revClient = testCase.client();
        let revServer = testCase.server();

        this.configureCollapsedRequest(revClient.request, resource);
        for (let worker = 1; worker <= workers; ++worker) {
            testCase.makeClients(collapsedRequests, (collapsedClient) => {
                if (workers > 1)
                    collapsedClient.nextHopAddress = this._workerListeningAddresses[worker];
                this.configureCollapsedRequest(collapsedClient.request, resource);
            });
        }

        revServer.response.tag(revalidationTag);

        revServer.serve(resource);

        if (serverStatus === 200)
            resource.modifiedAt(FuzzyTime.Now());
        else if (serverStatus === 304) {
            revServer.response.startLine.code(304);
            revServer.response.body = null;
        }

        if (Config.RequestType === "auth")
            revServer.response.header.add("Cache-Control", 'max-age=60, public');
        else
            revServer.response.header.add("Cache-Control", 'max-age=60');

        testCase.server().transaction().blockSendingUntil(
                testCase.clientsSentEverything(),
                "wait for all clients to collapse");

        testCase.check(() => {
            const smp = workers > 1;
            const serverTransactions = testCase.server().finishedTransactions() - 1; // all but the miss request
            const clientTransactions = workers * collapsedRequests;
            const collapsedTransactions = clientTransactions - serverTransactions;
            const collapsedRatio = Math.round(collapsedTransactions * 100 / (clientTransactions));
            if (serverTransactions > 1 && !smp) {
                console.log(`Warning: only ${collapsedTransactions} out of ${clientTransactions} ` +
                    `collapsable requests (${collapsedRatio}%) were collapsed.`);
            }
            // SMP mode does not support collapsing (yet)
            const threshold = smp ? 0 : Config.CollapsedThreshold;
            const scope = smp ? "SMP" : "non-SMP";
            assert(collapsedRatio >= threshold, `Expected collapsed requests ratio (${scope})`);

            for (let client of testCase.clients()) {
                const updatedResponse = client.transaction().response;
                const clientStatus = updatedResponse.startLine.codeInteger();
                const updatedTag = updatedResponse.tag();

                assert.equal(updatedTag, revalidationTag, "updated X-Daft-Response-Tag");
                assert.equal(clientStatus, expectedClientStatus, "expected response status code");
                if (serverStatus === 304 && expectedClientStatus === 200)
                     assert.equal(updatedResponse.header.value(hitCheck.name), hitCheck.value, "preserved originally cached header field");
            }
        });

        await testCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async run(/*testRun*/) {
        await this.checkOne();
    }
}


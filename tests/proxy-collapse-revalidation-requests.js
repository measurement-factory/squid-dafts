/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

/* Tests whether an HTTP proxy can "collapse" revalidation requests */

import HttpTestCase from "../src/test/HttpCase";
import Promise from "bluebird";
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
        option: "workers", // proxy may not support collapsing if workers > 1
        type: "Number",
        default: "1",
        description: "the number of clients",
    },
    {
        option: "collapsed-requests",
        type: "Number",
        default: "2",
        description: "the number of collapsed requests",
    },
    {
        option: "revalidation-request",
        type: "String",
        enum: ["basic", "ims", "refresh", "auth"],
        default: "basic",
        description: "special request headers to add to the revalidation request (add nothing by default)"
    },
    {
        option: "server-status",
        type: "Number",
        enum: [ "200", "304", "500" ],
        default: "200",
        description: "server response status code",
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
        configGen.addGlobalConfigVariation({workers: ["1"]});
        configGen.addGlobalConfigVariation({revalidationRequest: ["basic", "ims", "refresh", "auth"]});
        configGen.addGlobalConfigVariation({serverStatus: ["200", "304", "500"]});
        return configGen.generateConfigurators();
    }

    async cacheSomething(resource, hitCheck, tag) {
        let testCase = new HttpTestCase('forward a cachable response');
        testCase.client().request.for(resource);
        testCase.server().serve(resource);
        testCase.server().response.tag(tag);
        testCase.server().response.header.add(hitCheck);
        testCase.server().response.header.add("Cache-Control", "max-age=0, must-revalidate");
        testCase.client().checks.add((client) => {
            client.expectStatusCode(200);
        });
        await testCase.run();
    }

    configureCollapsedRequest(request, resource) {
        request.for(resource);
        if (Config.RevalidationRequest === "auth")
            request.header.add("Authorization", "Basic dXNlcjpwYXNz"); // user:pass
        else if (Config.RevalidationRequest === "ims")
            request.conditions({ ims: resource.notModifiedSince() });
        else if (Config.RevalidationRequest === "refresh")
            request.header.add("Cache-Control", "max-age=0");
    }

    clientStatus(serverStatus) {
        if (serverStatus === 500 || (serverStatus === 304 && Config.RevalidationRequest === "ims"))
            return serverStatus;
       return 200;
    }

    async checkOne()
    {
        const originalTag = "cached";
        const revalidationTag = "revalidated";
        const collapsedRequests = Number.parseInt(Config.CollapsedRequests, 10);
        const serverStatus = Number.parseInt(Config.ServerStatus, 10);
        const workers = Number.parseInt(Config.Workers, 10);
        const expectedClientStatus = this.clientStatus(serverStatus);
        const expectedClientTag = revalidationTag;

        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.modifiedAt(FuzzyTime.DistantPast());
        resource.finalize();

        const hitCheck = new Field("X-Daft-Hit-Check", Gadgets.UniqueId("check"));
        await this.cacheSomething(resource, hitCheck, originalTag);

        let testCase = new HttpTestCase("send " + Config.CollapsedRequests + " requests to check collapsed revalidation");
        let revClient = testCase.client();
        let revServer = testCase.server();

        this.configureCollapsedRequest(revClient.request, resource);
        for (let worker = 1; worker <= workers; ++worker) {
            testCase.makeClients(collapsedRequests, (collapsedClient) => {
                if (workers > 1)
                    collapsedClient.nextHopAddress = this._workerListeningAddresses[worker];
                this.configureCollapsedRequest(collapsedClient.request, resource);
                collapsedClient.transaction().blockSendingUntil(
                    testCase.server().transaction().receivedEverything(),
                    "wait for the first revalidation request to reach the server");
            });
        }

        revServer.response.tag(revalidationTag);

        revServer.serve(resource);

        if (serverStatus === 200)
            resource.modifiedAt(FuzzyTime.Now());
        else { // 304 or 500
            revServer.response.startLine.code(serverStatus);
            revServer.response.body = null;
        }

        let cacheControlValue = "max-age-60";
        if (Config.RevalidationRequest === "auth")
            cacheControlValue += ", public";
        revServer.response.header.add("Cache-Control", cacheControlValue);

        testCase.server().transaction().blockSendingUntil(
                this.dut.waitCollapsed(resource.uri.path, collapsedRequests + 1),
                "wait for all revalidation clients to collapse");

        testCase.check(() => {
            for (let client of testCase.clients()) {
                const updatedResponse = client.transaction().response;
                const clientStatus = updatedResponse.startLine.codeInteger();
                const updatedTag = updatedResponse.tag();

                assert.equal(updatedTag, expectedClientTag, "expected X-Daft-Response-Tag");
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


/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

/* Tests whether an HTTP proxy can "collapse" internal revalidation requests */

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
        option: "clients", // proxy may not support collapsing if workers > 1
        type: "Number",
        default: "1",
        description: "the number of clients, each client connecting to a separate proxy worker",
    },
    {
        option: "requests",
        type: "Number",
        default: "2",
        description: "the number of requests per client",
    },
    {
        option: "revalidation-request",
        type: "String",
        enum: ["none", "ims", "refresh", "auth"],
        default: "none",
        description: "special request headers to add to the revalidation request (none by default)"
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
        if (Config.Clients > 1) {
            cfg.workers(Config.Clients);
            cfg.dedicatedWorkerPorts(true);
            this._workerListeningAddresses = cfg.workerListeningAddresses();
        }
    }

    static Configurators() {
        const configGen = new ConfigGen();
        configGen.addGlobalConfigVariation({clients: ["1"]});
        configGen.addGlobalConfigVariation({revalidationRequest: ["none", "ims", "refresh", "auth"]});
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

    configureRequest(request, resource) {
        request.for(resource);
        if (Config.RevalidationRequest === "auth")
            request.header.add("Authorization", "Basic dXNlcjpwYXNz"); // user:pass
        else if (Config.RevalidationRequest === "ims")
            request.conditions({ ims: resource.notModifiedSince() });
        else if (Config.RevalidationRequest === "refresh")
            request.header.add("Cache-Control", "max-age=0");
    }

    statusExpectedByClient(statusSentByServer) {
        if (statusSentByServer === 500 || (statusSentByServer === 304 && Config.RevalidationRequest === "ims"))
            return statusSentByServer;
       return 200;
    }

    async run(/*testRun*/) {
        const originalTag = "cached";
        const revalidationTag = "revalidated";
        const requests = Number.parseInt(Config.Requests, 10);
        const workers = Number.parseInt(Config.Clients, 10);
        const statusSentByServer = Number.parseInt(Config.ServerStatus, 10);
        const statusExpectedByClient = this.statusExpectedByClient(statusSentByServer);
        const tagExpectedByClient = revalidationTag;

        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.modifiedAt(FuzzyTime.DistantPast());
        resource.finalize();

        // sent in the initially cached response
        // must appear in the revalidated response
        const hitCheck = new Field("X-Daft-Hit-Check", Gadgets.UniqueId("check"));
        await this.cacheSomething(resource, hitCheck, originalTag);

        let testCase = new HttpTestCase("send " + requests * workers + " requests to check internal requests collapsing");
        let revClient = testCase.client();
        let revServer = testCase.server();

        this.configureRequest(revClient.request, resource);
        for (let worker = 1; worker <= workers; ++worker) {
            testCase.makeClients(requests, (client) => {
                if (this._workerListeningAddresses)
                    client.nextHopAddress = this._workerListeningAddresses[worker];
                this.configureRequest(client.request, resource);
                client.transaction().blockSendingUntil(
                    testCase.server().transaction().receivedEverything(),
                    "wait for the first internal request to reach the server");
            });
        }

        revServer.response.tag(revalidationTag);

        revServer.serve(resource);

        if (statusSentByServer === 200)
            resource.modifiedAt(FuzzyTime.Now());
        else { // 304 or 500
            revServer.response.startLine.code(statusSentByServer);
            revServer.response.body = null;
        }

        if (Config.RevalidationRequest === "auth")
            revServer.response.header.add("Cache-Control", "public");
        revServer.response.finalize();

        testCase.server().transaction().blockSendingUntil(
                this.dut.finishStagingRequests(resource.uri.path, requests + 1),
                "wait until proxy stages all revalidation requests");

        testCase.check(() => {
            for (let client of testCase.clients()) {
                const updatedResponse = client.transaction().response;
                const clientStatus = updatedResponse.startLine.codeInteger();
                const updatedTag = updatedResponse.tag();

                assert.equal(updatedTag, tagExpectedByClient, "expected X-Daft-Response-Tag");
                assert.equal(clientStatus, statusExpectedByClient, "expected response status code");
                if (statusSentByServer === 304 && statusExpectedByClient === 200)
                     assert.equal(updatedResponse.header.value(hitCheck.name), hitCheck.value, "preserved originally cached header field");
            }
        });

        await testCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }
}


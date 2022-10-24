/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

/* Tests whether an HTTP proxy does not share
   non-shareable(private) responses */

import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import * as AddressPool from "../src/misc/AddressPool";
import * as FuzzyTime from "../src/misc/FuzzyTime";
import * as Gadgets from "../src/misc/Gadgets";
import * as Config from "../src/misc/Config";
import * as Http from "../src/http/Gadgets";
import ConfigGen from "../src/test/ConfigGen";
import assert from "assert";
import Test from "../src/overlord/Test";

Config.Recognize([
    {
    option: "clients-count",
    type: "Number",
    default: "2",
    description: "number of clients",
},
]);

export default class MyTest extends Test {

    authClt(cltTest, srvTest, resource) {
        for (let client of cltTest.clients()) {
            client.request.header.add("Authorization", "Basic dXNlcjpwYXNz"); // user:pass
        }
    }
    
    privateSrv(cltTest,resource) {
        cltTest.server().response.header.add("Cache-Control", "private");
    }
    
    noStoreClt(cltTest, resource) {
        for (let client of cltTest.clients()) {
            client.request.header.add("Cache-Control", "no-store");
        }
    }
    
    noStoreSrv(cltTest, resource) {
        cltTest.server().response.header.add("Cache-Control", "no-store");
    }

    _configureDut(cfg) {
        cfg.memoryCaching(true);
        cfg.collapsedForwarding(true);
    }

    static Configurators() {
        const configGen = new ConfigGen();
        configGen.addGlobalConfigVariation({clientsCount: ["clients-count", "2", "4"]});
        return configGen.generateConfigurators();
    }

    async cacheSomething(resource) {
        let testCase = new HttpTestCase('cache something');
        testCase.client().request.for(resource);
        testCase.server().serve(resource);
        testCase.server().response.header.add("Cache-Control", "max-age=0");
        await testCase.run();
    }
    
    async doSingleCheck(revalidation, makePrivate)
    {
        const clientsCount = Number.parseInt(Config.ClientsCount, 10);
    
        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.modifiedAt(FuzzyTime.DistantPast());
        resource.finalize();
    
        if (revalidation)
            await this.cacheSomething(resource);
    
        let testCase = new HttpTestCase("send " + clientsCount.toString() + " requests to make Squid collapse on them");
        testCase.client().request.for(resource);
        testCase.makeClients(clientsCount - 1, (client => {
            client.request.for(resource);
        }));
    
        testCase.server().serve(resource);
        if (makePrivate)
            makePrivate(testCase, resource);
        testCase.server().transaction().blockSendingUntil(
                testCase.clientsSentEverything(),
                "wait for all clients to collapse");

        testCase.check(() => {
            const clients = testCase.clients();
            const parentID = clients[0].transaction().request.id();
            for (let i = 0; i < clients.length; ++i) {
                let request = clients[i].transaction().request;
                let response = clients[i].transaction().response;
                const sentID = request.id();
                const receivedID = response.otherID(request);
                const statusCode = response.startLine.codeString();
                let msg = "changed X-Daft-Response-Tag, private headers ";
                msg += makePrivate ? "on" : "off";
                if (i === 0) {
                    assert.equal(statusCode, 200);
                    assert.equal(parentID, receivedID, msg);
                } else {
                    if (!makePrivate)
                        assert.equal(parentID, receivedID, msg);
                    else // expecting 200 or 50x
                        assert(parentID !== receivedID);
                }
            }
        });

        await testCase.run();
    
        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async doCheck(revalidation, isPrivate) {
        await this.doSingleCheck(revalidation, isPrivate ? this.authClt : null);
        await this.doSingleCheck(revalidation, isPrivate ? this.noStoreClt : null);
        await this.doSingleCheck(revalidation, isPrivate ? this.noStoreSrv : null);
        await this.doSingleCheck(revalidation, isPrivate ? this.privateSrv : null);
    }

    async run(/*testRun*/) {
        console.log("Test A: the proxy must support entries sharing(collapsing)");
        await this.doCheck(false, false);
        console.log("Test B: the proxy must not share private entries on revalidation");
        await this.doCheck(true, true);
    }
}


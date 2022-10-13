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
    default: "3",
    description: "number of clients",
},
    {
    option: "kind",
    type: "String",
    enum: ["collapse-fwd", "collapse-rev" ],
    description: "test either common collapse forwarding or collapsing on revalidation"
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
        configGen.addGlobalConfigVariation({kind: ["collapse-fwd", "collapse-rev"]});
        return configGen.generateConfigurators();
    }

    async cacheSomething(resource) {
        let testCase = new HttpTestCase('cache something');
        testCase.client().request.for(resource);
        testCase.server().serve(resource);
        testCase.server().response.tag("cache");
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
        let i = 1;
        const tag = revalidation ? 'rev-' : 'fwd-'; 
        const parentTag = tag + i.toString();
        testCase.client().request.tag(parentTag);
        testCase.makeClients(clientsCount - 1, (client => {
            i++;
            client.request.for(resource);
            client.request.tag(tag + i.toString());
        }));
    
        testCase.server().response.copyTag(true);
        testCase.server().serve(resource);
        if (makePrivate)
            makePrivate(testCase, resource);
        testCase.server().transaction().blockSendingUntil(
                testCase.clientsSentEverything(),
                "wait for all clients to collapse");

        testCase.check(() => {
            const clients = testCase.clients();
            for (let i = 0; i < clients.length; ++i) {
                let client = clients[i];
                const sentTag = client.transaction().request.tag();
                const receivedTag = client.transaction().response.tag();
                const statusCode = client.transaction().response.startLine.codeString();
                let msg = "changed X-Daft-Response-Tag, private headers ";
                msg += makePrivate ? "on" : "off";
                if (i === 0) {
                    assert.equal(statusCode, 200);
                    assert.equal(sentTag, receivedTag, msg);
                    assert.equal(parentTag, receivedTag, msg);
                } else {
                    if (!makePrivate)
                        assert.equal(parentTag, receivedTag, msg);
                    else // expecting 200 or 50x
                        assert(parentTag !== receivedTag);
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
        const revalidation = Config.Kind === "collapse-rev";
        const revalidationPhrase = revalidation ? " on revalidation" : ""; 
        assert(revalidation || Config.Kind === "collapse-fwd");

        console.log("Test A: the proxy must support entries sharing(collapsing)" + revalidationPhrase);
        await this.doCheck(revalidation, false);
        console.log("Test B: the proxy must not share private entries" + revalidationPhrase);
        await this.doCheck(revalidation, true);
    }
}


/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

/* Tests whether an HTTP proxy does not share non-shareable(private) responses */

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

// all clients arrive before response headers
const soCollapsing = "ch-sh-sb";
// all-but-one clients arrive after the proxy gets the response headers
const soLiveFeeding = "sh-ch-sb";
// all clients arrive before response headers on an internal proxy revalidation request
const soInternalCollapsing = "ch-srh-srb";

Config.Recognize([
    {
        option: "clients",
        type: "Number",
        default: "2",
        description: "number of clients",
    },
    {
        // Here "clients" means all clients except the very 1st client that
        // always starts the transaction. "c" is client, "s" is server, "h" is
        // sent message headers, "r" is revalidation and "b" is sent message body.
        option: "scenario",
        type: "String",
        enum: [soCollapsing, soLiveFeeding, soInternalCollapsing],
        default: soCollapsing,
        description: "\n" +
            "\tch-sh-sb (clients send headers before server sends headers)\n"+
            "\tsh-ch-sb (server sends headers before clients send headers)\n"+
            "\tch-srh-srb (clients send headers before server sends revalidation headers)\n"
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
        cfg.collapsedForwarding(Config.Scenario !== soLiveFeeding);
    }

    static Configurators() {
        const configGen = new ConfigGen();
        configGen.addGlobalConfigVariation({clients: ["2", "4"]});
        configGen.addGlobalConfigVariation({scenario: [ soCollapsing, soLiveFeeding, soInternalCollapsing ]});
        return configGen.generateConfigurators();
    }

    async cacheSomething(resource) {
        let testCase = new HttpTestCase('cache something');
        testCase.client().request.for(resource);
        testCase.server().serve(resource);
        if (Config.Scenario === soInternalCollapsing);
            testCase.server().response.header.add("Cache-Control", "max-age=0, must-revalidate"); // could use 'no-cache' instead
        await testCase.run();
    }

    _blockClient(hitClient, missClient, testCase) {
        if (Config.Scenario === soLiveFeeding) {
            hitClient.transaction().blockSendingUntil(
                missClient.transaction().receivedHeaders(),
                "wait for the miss response headers to reach the 1st client");
        } else {
            assert(Config.Scenario === soCollapsing || Config.Scenario === soInternalCollapsing);
            hitClient.transaction().blockSendingUntil(
                testCase.server().transaction().receivedEverything(),
                "wait for the miss request to reach the server");
        }
    }

    _blockServer(server, testCase) {
        if (Config.Scenario === soLiveFeeding) {
            server.transaction().blockSendingBodyUntil(
                testCase.clientsSentEverything(),
                "wait for all clients to send requests");
        } else {
            assert(Config.Scenario === soCollapsing || Config.Scenario === soInternalCollapsing);
            server.transaction().blockSendingUntil(
                testCase.clientsSentEverything(),
                "wait for all clients to collapse");
        }
    }
    
    async checkOne(makePrivate)
    {
        const clientsCount = Number.parseInt(Config.Clients, 10);
        console.log("clients = " + clientsCount);
    
        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.modifiedAt(FuzzyTime.DistantPast());
        resource.finalize();
    
        if (Config.Scenario === soInternalCollapsing)
            await this.cacheSomething(resource);
    
        let testCase = new HttpTestCase("send " + clientsCount.toString() + " requests to make Squid collapse on them");
        let missClient = testCase.client();
        missClient.request.for(resource);

        testCase.makeClients(clientsCount - 1, (client => {
            client.request.for(resource);
            this._blockClient(client, missClient, testCase);
        }));
    
        testCase.server().serve(resource);

        if (makePrivate)
            makePrivate(testCase, resource);

        this._blockServer(testCase.server(), testCase);

        testCase.check(() => {
            const clients = testCase.clients();
            const parentID = clients[0].transaction().request.id();
            for (let i = 0; i < clients.length; ++i) {
                let request = clients[i].transaction().request;
                let response = clients[i].transaction().response;
                const receivedID = response.requestId(request);
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

    async run(/*testRun*/) {
        console.log("Test A: the proxy must support entries sharing(collapsing)");
        await this.checkOne(null);

        console.log("Test B: the proxy must not share private entries");
        await this.checkOne(this.authClt);
        await this.checkOne(this.noStoreClt);
        await this.checkOne(this.noStoreSrv);
        await this.checkOne(this.privateSrv);
    }
}


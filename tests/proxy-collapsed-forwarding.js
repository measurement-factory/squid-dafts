/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

/* Tests whether an HTTP proxy caches a response
 * Parameters: [drop-Content-Length] [body size] */

import assert from "assert";
import HttpTestCase from "../src/test/HttpCase";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import * as Gadgets from "../src/misc/Gadgets";
import * as Config from "../src/misc/Config";
import * as AddressPool from "../src/misc/AddressPool";
import { Must } from "../src/misc/Gadgets";
import Test from "../src/test/Test";
import { DutConfig, ProxyOverlord } from "../src/overlord/Proxy";

// Compute syntax specification for the --collapsed-requests option.
// The WorkerLimit is only needed to keep --help output reasonable.
// TODO: Improve --collapsed-requests syntax specification and/or help.
const WorkerLimit = 8;
let CollapsedRequestsType = "{each:Maybe Number";
for (let i = 0; i < WorkerLimit; ++i) {
    CollapsedRequestsType += `,${i + 1}:Maybe Number`;
}
CollapsedRequestsType += "}";

Config.Recognize([
    {
        option: "workers",
        type: "Number",
        default: "4",
        description: "the number of Squid SMP workers",
    // TODO: Validate: workers <= WorkerLimit.
    },
    {
        // The miss transaction always goes through the first worker.
        // Collapsed requests go to the workers mapped by this option.
        // For example, to send 2 collapsed requests to each worker
        // but keep the third worker idle, use --collapsed-requests each:2,3:0
        option: "collapsed-requests",
        type: CollapsedRequestsType,
        default: "{each:2}",
        description: "the number of collapsed requests for each worker",
    }
]);

export default class MyTest extends Test {

    constructor(...args) {
        // XXX: We should not be writing constructors to configure a DUT.
        // TODO: Add virtual Test::configureDut() or a similar method.
        const cfg = new DutConfig();
        cfg.workers(Config.Workers);
        cfg.dedicatedWorkerPorts(true);
        cfg.collapsedForwarding(true);
        cfg.memoryCaching(true); // TODO: Make Configurable.
        cfg.diskCaching(true); // TODO: Make Configurable.
        super(new ProxyOverlord(cfg), ...args); // no DUT for now

        this._workerListeningAddresses = cfg.workerListeningAddresses();
    }

    async run(/*testRun*/) {

        // TODO: Zero workers should mean non-SMP mode.
        Must(Config.Workers >= 1);

        // convert Config.CollapsedRequests (which may not specify some
        // workers and/or have an "each" macro) into collapsedRequestsForWorker
        const defaultRequests = 'each' in Config.CollapsedRequests ?
            Config.CollapsedRequests.each : 0;
        let collapsedRequestsForWorker = Array(1 + Config.Workers).fill(defaultRequests);
        for (let workerLabel of Object.keys(Config.CollapsedRequests)) {
            if (workerLabel === "each") // handled above
                continue;
            assert(workerLabel > 0);
            assert(workerLabel <= WorkerLimit);
            assert(workerLabel <= Config.Workers); // a worker ID in --collapsed-requests list exceeded --workers value
            collapsedRequestsForWorker[workerLabel] = Config.CollapsedRequests[workerLabel];
        }

        let resource = new Resource();
        resource.makeCachable();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.body = new Body(Gadgets.UniqueId("body-"));
        resource.finalize();

        let testCase = new HttpTestCase('one and only'); // TODO: Use a testRun-based label
        testCase.server().serve(resource);
        testCase.server().response.tag("first");
        let missClient = testCase.client();
        missClient.request.for(resource);
        missClient.nextHopAddress = this._workerListeningAddresses[1];
        missClient.expectStatusCode(200);
        missClient.checks.add((client) => {
            assert(client.transaction().response, "Proxy must send a response");
            const initiatorTag = client.transaction().response.tag();
            assert.equal(initiatorTag, "first", "Squid collapsing initiator worker X-Daft-Response-Tag XXX");
            let responseBody = client.transaction().response.body.whole();
            // XXX: Don't we have a message comparison function?
            assert.equal(responseBody, resource.body.whole(), "Got response body");
        });

        // add clients for each worker; they should all collapse on missClient
        for (let worker = 1; worker <= Config.Workers; ++worker) {
            testCase.makeClients(collapsedRequestsForWorker[worker], (hitClient) => {
                hitClient.request.for(resource);
                hitClient.nextHopAddress = this._workerListeningAddresses[worker];

                // technically, reaching the proxy is enough, but we cannot detect/wait for that
                hitClient.transaction().blockSendingUntil(
                    testCase.server().transaction().receivedEverything(),
                    "wait for the miss request to reach the server");

                hitClient.expectStatusCode(200);
                hitClient.checks.add((client) => {
                    // XXX: Revise hit checks. Remove duplication. Move to a method?
                    assert(client.transaction().response, "Proxy must send a response");
                    const initiatorTag = client.transaction().response.tag();
                    assert.equal(initiatorTag, "first", "Squid collapsing initiator worker X-Daft-Response-Tag XXX");
                    let responseBody = client.transaction().response.body.whole();
                    // XXX: Don't we have a message comparison function?
                    assert.equal(responseBody, resource.body.whole(), "Got response body");
                });
            });
        }

        testCase.server().transaction().blockSendingUntil(
            testCase.clientsSentEverything(),
            "wait for all clients to collapse");

        await testCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

}

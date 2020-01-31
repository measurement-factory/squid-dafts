// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests whether an HTTP proxy can merge concurrently received requests into a
// single sent request. Also tests cache hit delivery to concurrent clients.

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

// all clients arrive before response headers
const soTrueCollapsing = "ch-sh-sb";
// all-but-one clients arrive after the proxy gets the response headers
const soLiveFeeding = "sh-ch-sb";
// all-but-one clients arrive after the proxy gets the response body
const soPureHits = "sh-sb-ch";

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
    },
    {
        // Here "clients" means all clients except the very 1st client that
        // always starts the transaction. "c" is client, "s" is server, h" is
        // sent message headers, and "b" is sent message body.
        option: "sending-order",
        type: "String",
        enum: [soTrueCollapsing, soLiveFeeding, soPureHits],
        default: soTrueCollapsing,
        description: "\n" +
            "\tch-sh-sb (clients send headers before server sends headers)\n"+
            "\tsh-ch-sb (server sends headers before clients send headers)\n"+
            "\tsh-sb-ch (server sends body before clients send headers)\n",
    },
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
        let missClient = testCase.client();
        missClient.request.for(resource);
        missClient.nextHopAddress = this._workerListeningAddresses[1];

        // add clients for each worker; they should all collapse on missClient
        for (let worker = 1; worker <= Config.Workers; ++worker) {
            testCase.makeClients(collapsedRequestsForWorker[worker], (hitClient) => {
                hitClient.request.for(resource);
                hitClient.nextHopAddress = this._workerListeningAddresses[worker];
                this._blockClient(hitClient, missClient, testCase);
            });
        }

        this._blockServer(testCase);

        testCase.addMissCheck();

        await testCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    _blockClient(hitClient, missClient, testCase) {
        if (Config.SendingOrder === soTrueCollapsing) {
            // technically, reaching the proxy is enough, but we cannot detect/wait for that
            hitClient.transaction().blockSendingUntil(
                testCase.server().transaction().receivedEverything(),
                "wait for the miss request to reach the server");
            return;
        }

        if (Config.SendingOrder === soLiveFeeding) {
            hitClient.transaction().blockSendingUntil(
                missClient.transaction().receivedHeaders(),
                "wait for the miss response headers to reach the 1st client");
            return;
        }

        if (Config.SendingOrder === soPureHits) {
            hitClient.transaction().blockSendingUntil(
                missClient.transaction().receivedEverything(),
                "wait for the whole miss response to reach the 1st client");
            return;
        }

        assert(false); // not reached
    }

    _blockServer(testCase) {
        if (Config.SendingOrder === soTrueCollapsing) {
            testCase.server().transaction().blockSendingUntil(
                testCase.clientsSentEverything(),
                "wait for all clients to collapse");
            return;
        }

        if (Config.SendingOrder === soLiveFeeding) {
            testCase.server().transaction().blockSendingBodyUntil(
                testCase.clientsSentEverything(),
                "wait for all clients to send requests");
            return;
        }

        if (Config.SendingOrder === soPureHits) {
            // no need to delay the server
            return;
        }

        assert(false); // not reached
    }
}

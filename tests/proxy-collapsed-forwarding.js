// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests whether an HTTP proxy can merge concurrently received requests into a
// single sent request. Also tests cache hit delivery to concurrent clients.

import assert from "assert";

import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import * as Http from "../src/http/Gadgets";
import ConfigGen from "../src/test/ConfigGen";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import Test from "../src/overlord/Test";
import { Must } from "../src/misc/Gadgets";

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

    static Configurators() {
        const configGen = new ConfigGen();

        configGen.addGlobalConfigVariation({dutMemoryCache: [
            false,
            true,
        ]});

        configGen.addGlobalConfigVariation({dutDiskCache: [
            false,
            true,
        ]});

        configGen.addGlobalConfigVariation({sendingOrder: [
            soTrueCollapsing,
            soLiveFeeding,
            soPureHits,
        ]});

        configGen.addGlobalConfigVariation({collapsedRequests: [
            {each: 1, 1: 0},
            {each: 2},
        ]});

        // XXX: Zero Config.bodySize() responses cannot be used for
        // soLiveFeeding cases because we cannot tell the server to block
        // (after sending headers and) before sending body when there is no
        // body to send. Body-less soLiveFeeding cases are currently the same
        // as soPureHits cases. A zero decoded body size test can only work
        // correctly with chunked responses (see TODO below).
        configGen.addGlobalConfigVariation({bodySize: [
            0,
            Config.DefaultBodySize(),
            Config.LargeBodySize(),
        ]});

        // TODO: Chunking.

        configGen.addGlobalConfigAdjustment('retries', config => {
            if (config.SendingOrder !== soTrueCollapsing) {
                const attempts = config.Tests === undefined ? 10 : config.Tests;
                config.use({retries: attempts-1});
            }
        });

        return configGen.generateConfigurators();
    }

    _configureDut(cfg) {
        cfg.workers(Config.Workers); // TODO: This should be the default.
        cfg.dedicatedWorkerPorts(true); // TODO: This should be the default.
        cfg.collapsedForwarding(Config.SendingOrder === soTrueCollapsing); // TODO: Make configurable.

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
        resource.finalize();

        // cache_dir rock cannot read while writing, resulting in misses (and
        // 503 responses from Squid) in rock-only non-CF tests
        // TODO: Exclude soPureHits after adding this.dut.finishCaching().
        const expect503sDueToRockLimitations =
            Config.dutDiskCache() &&
            Config.sendingOrder() !== soTrueCollapsing;

        // when there is no caching at all, all clients ought to miss, and all
        // secondary clients ought to get a 503 error response
        const expect503sDueToAbsentCache = !this.dut.config().cachingEnabled();

        const expect503s = expect503sDueToAbsentCache || expect503sDueToRockLimitations;

        let testCase = new HttpTestCase('one and only'); // TODO: Use a testRun-based label
        testCase.server().serve(resource);
        let missClient = testCase.client();
        missClient.request.for(resource);
        missClient.nextHopAddress = this._workerListeningAddresses[1];

        if (expect503s) {
            // testCase.addMissCheck() would have included 503-getting clients
            missClient.checks.add(() => {
                missClient.expectResponse(testCase.server().transaction().response);
            });
        }

        // add clients for each worker; they should all collapse on missClient
        for (let worker = 1; worker <= Config.Workers; ++worker) {
            testCase.makeClients(collapsedRequestsForWorker[worker], (hitClient) => {
                hitClient.request.for(resource);
                hitClient.nextHopAddress = this._workerListeningAddresses[worker];
                this._blockClient(hitClient, missClient, testCase);
                if (expect503s) {
                    hitClient.checks.add(client => {
                        const scode = client.transaction().response.startLine.codeInteger();
                        switch (scode) {
                            case 503:
                                return; // nothing to check for a failed hit
                            case 200: {
                                // A lucky request may get a hit but not if
                                // there is no cache at all. Unfortunately,
                                // Squid does collapse requests when there is
                                // no cache. Just warn until that is fixed.
                                // TODO: assert(this.dut.config().cachingEnabled());
                                if (!this.dut.config().cachingEnabled())
                                    console.log("Warning: Ignoring that a cache-less proxy collapsed requests");
                                Http.AssertForwardedMessage(
                                    testCase.server().transaction().response,
                                    client.transaction().response,
                                    "response");
                                return;
                            }
                            default: {
                                const or200 = this.dut.config().cachingEnabled() ? " or an occasional 200" : "";
                                throw new Error(`A secondary client expected a 503${or200}, but received a ${scode} response status code.`);
                            }
                        }
                    });
                }
            });
        }

        // TODO: These parameters should probably become MyTest data members.
        this._blockServer(expect503s, resource, testCase);

        if (!expect503s)
            testCase.addMissCheck(); // all clients

        await testCase.run();

        if (this.dut.config().cachingEnabled()) {
            let afterCase = new HttpTestCase('afterwards');
            let afterClient = afterCase.client();
            afterClient.request.for(resource);
            afterClient.nextHopAddress = this._workerListeningAddresses[1];
            afterCase.addHitCheck(testCase.server().transaction().response);
            await afterCase.run();
        }

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

    _blockServer(expect503s, resource, testCase) {
        if (Config.SendingOrder === soTrueCollapsing) {
            const event = expect503s ?
                testCase.clientsSentEverything() :
                this.dut.finishStagingRequests(resource.uri.path, testCase.clients().length);
            testCase.server().transaction().blockSendingUntil(
                event,
                "wait for all clients to collapse");
            return;
        }

        if (Config.SendingOrder === soLiveFeeding) {
            // See XXX in addGlobalConfigVariation('bodySize'...)
            if (!Config.bodySize())
                return;

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

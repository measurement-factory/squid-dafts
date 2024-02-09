// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests whether worker A attempts to revalidate an HTTP response that is
// being received from worker B (because worker A request was collapsed).

// XXX: Currently, the test attempts to trigger said revalidation (in hope
// that it will hit a certain Squid assertion), but does not check much.

import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import * as ConfigurationGenerator from "../src/test/ConfigGen";
import * as FuzzyTime from "../src/misc/FuzzyTime";
import * as Http from "../src/http/Gadgets";
import Field from "../src/http/Field";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import Test from "../src/overlord/Test";

import assert from "assert";

// TODO: Duplicates proxy-collapsed-forwarding.js.
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
        description: "the number of Squid worker processes",
    },
    {
        option: "poke-same-worker",
        type: "Boolean",
        description: "send all test case requests to the same Squid worker process",
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

    _configureDut(cfg) {
        assert(Config.dutMemoryCache() || Config.dutDiskCache());
        cfg.workers(Config.workers());
        cfg.dedicatedWorkerPorts(Config.workers() > 1);
        this._workerListeningAddresses = cfg.workerListeningAddresses();
        cfg.collapsedForwarding(Config.sendingOrder() === soTrueCollapsing); // TODO: Make configurable.
    }

    static Configurators() {
        const configGen = new ConfigurationGenerator.FlexibleConfigGen();

        configGen.workers(function *() {
            yield 1; // minimal working configuration
            yield 5; // the number of test cases; see Config.pokeSameWorker()
        });

        configGen.pokeSameWorker(function *(cfg) {
            if (cfg.workers() > 1) // poking different workers requires multiple workers
                yield false;
            yield true;
        });

        configGen.dutMemoryCache(function *() {
            yield false;
            yield true;
        });

        configGen.dutDiskCache(function *(cfg) {
            if (cfg.dutMemoryCache()) // do not end up with no caching at all
                yield false;
            yield true;
        });

        configGen.sendingOrder(function *(cfg) {
            yield soTrueCollapsing;
            // XXX: Remove? yield soLiveFeeding;
            // XXX: This allows testing revalidation w/o collapsing: yield soPureHits;
        });

        return configGen.generateConfigurators();
    }

    async run(/*testRun*/) {
        const resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.modifiedAt(FuzzyTime.DistantPast());
        resource.expireAt(FuzzyTime.Now());
        resource.finalize();

        // TODO: Rename to testCase if this is the only one
        const firstCase = new HttpTestCase(`cache a response and collapse on the miss request`);
        const missClient = firstCase.client();
        {
            missClient.request.for(resource);
            missClient.nextHopAddress = this._workerListeningAddressFor(1);

            firstCase.server().serve(resource);

            firstCase.check(() => {
                missClient.expectStatusCode(200);
            });
        }

        firstCase.makeClients(1, (hitClient) => {
            hitClient.request.for(resource);
            hitClient.nextHopAddress = this._workerListeningAddressFor(2);
            hitClient.request.header.add("Cache-Control", "max-age=0");

            this._blockClient(hitClient, missClient, firstCase);
            firstCase.check(() => {
                hitClient.expectStatusCode(200);
            });
        });

        this._blockServer(resource, firstCase);

        // expect 2 transactions: miss and revalidation
        firstCase.server().onSubsequentTransaction((x) => {
            console.log("XXX2: onSubsequentTransaction", x);
            x.response.startLine.code(304);
        });

        // XXX: ERR_ASSERTION]: same response X-Daft-Request-ID field value
        // firstCase.addMissCheck();

        await firstCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    // TODO: Duplicates proxy-collapsed-forwarding.js
    _blockClient(hitClient, missClient, testCase) {
        if (Config.sendingOrder() === soTrueCollapsing) {
            // technically, reaching the proxy is enough, but we cannot detect/wait for that
            hitClient.transaction().blockSendingUntil(
                testCase.server().transaction().receivedEverything(),
                "wait for the miss request to reach the server");
            return;
        }

        if (Config.sendingOrder() === soLiveFeeding) {
            hitClient.transaction().blockSendingUntil(
                missClient.transaction().receivedHeaders(),
                "wait for the miss response headers to reach the 1st client");
            return;
        }

        if (Config.sendingOrder() === soPureHits) {
            hitClient.transaction().blockSendingUntil(
                missClient.transaction().receivedEverything(),
                "wait for the whole miss response to reach the 1st client");
            return;
        }

        assert(false); // not reached
    }

    // TODO: Poorly duplicates proxy-collapsed-forwarding.js
    _blockServer(resource, testCase) {
        if (Config.sendingOrder() === soTrueCollapsing) {
            const event = this.dut.finishStagingRequests(resource.uri.path, testCase.clients().length);
            testCase.server().transaction().blockSendingUntil(
                event,
                "wait for all clients to collapse");
            return;
        }

        if (Config.sendingOrder() === soLiveFeeding) {
            testCase.server().transaction().blockSendingBodyUntil(
                testCase.clientsSentEverything(),
                "wait for all clients to send requests");
            return;
        }

        if (Config.sendingOrder() === soPureHits) {
            // no need to delay the server
            return;
        }

        assert(false); // not reached
    }

    // TODO: Move/Refactor into Proxy::workerForStep().primaryAddress(): The
    // primary listening address of the round-robin selected worker. Here,
    // "primary" means a worker-designated address (if it exists) or the
    // general proxy listening address (otherwise).
    _workerListeningAddressFor(stepId)
    {
        assert(stepId >= 1);

        let workerId = 1;
        if (!Config.pokeSameWorker()) {
            // use workers in round-robin fashion, using the first worker for
            // the first step; both worker and step IDs are 1-based
            assert(Config.workers() > 0);
            workerId = 1 + ((stepId-1) % Config.workers());
        }

        // The first this._workerListeningAddresses element is a well-known
        // port address shared by all workers. We do not use it here.
        const offset = 1 + (workerId - 1);
        assert(offset >= 0);
        assert(offset < this._workerListeningAddresses.length);
        return this._workerListeningAddresses[offset];
    }
}


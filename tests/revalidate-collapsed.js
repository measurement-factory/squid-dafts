// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests whether worker A attempts to revalidate an HTTP response that is
// being received from worker B (because worker A request was collapsed).
// Revalidation is _not_ expected:
// * Revalidation is not expected in soTrueCollapsing cases (despite Squid
//   being tempted to revalidate) because Squid should treat responses to
//   collapsed requests as fresh.
// * Revalidation is not expected in soLiveFeeding and soPureHits cases
//   because we do not tempt Squid to revalidate in those cases.

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
        assert(cfg.cachingEnabled());
        cfg.workers(Config.workers());
        cfg.dedicatedWorkerPorts(Config.workers() > 1);
        this._workerListeningAddresses = cfg.workerListeningAddresses();
        cfg.collapsedForwarding(Config.sendingOrder() === soTrueCollapsing);
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
            yield soPureHits;
            yield soLiveFeeding;
            yield soTrueCollapsing;
        });

        configGen.dropInvalidConfigurations(cfg => {
            if (cfg.dutDiskCache() &&
                cfg.sendingOrder() === soLiveFeeding) // when we cannot wait for Squid to cache the whole response
                throw new ConfigurationGenerator.ConfigurationError("Work around cache_dir inability to read while writing");
        });

        return configGen.generateConfigurators();
    }

    async run(/*testRun*/) {
        const resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.modifiedAt(FuzzyTime.DistantPast());
        resource.expireAt(Config.sendingOrder() === soTrueCollapsing ? FuzzyTime.Now() : FuzzyTime.DistantFuture());
        resource.finalize();

        const testCase = new HttpTestCase(`cache a response and collapse on the miss request`);
        const missClient = testCase.client();
        {
            missClient.request.for(resource);
            missClient.nextHopAddress = this._workerListeningAddressFor(1);

            testCase.server().serve(resource);

            testCase.check(() => {
                missClient.expectStatusCode(200);
            });
        }

        testCase.makeClients(1, (hitClient) => {
            hitClient.request.for(resource);
            hitClient.nextHopAddress = this._workerListeningAddressFor(2);

            // tempt Squid to needlessly revalidate (where possible)
            if (Config.sendingOrder() === soTrueCollapsing)
                hitClient.request.header.add("Cache-Control", "max-age=0");

            this._blockClient(hitClient, missClient, testCase);
            testCase.check(() => {
                hitClient.expectStatusCode(200);
                if (testCase.server().transactionsStarted() === 1)
                    hitClient.expectResponse(testCase.server().transaction().response);
                // else we cannot use hitClient.expectResponse() because 200
                // response received by hitClient was updated by origin 304
                // response; we lack functions that check for such updates.
                // TODO: Check body forwarding (at least)!
            });
        });

        this._blockServer(resource, testCase);

        // Expect up to 2 transactions: miss and revalidation. Revalidation
        // happens in non-collapsed cases and in older Squids that validate
        // responses to collapsed requests.
        testCase.server().onSubsequentTransaction((x) => {
            x.response.startLine.code(304);
        });

        if (Config.sendingOrder() === soTrueCollapsing)
            testCase.addMissCheck();
        // else revalidation changes X-Daft-Request-ID response header value,
        // resulting in addMissCheck() failure; TODO: Check forwarding somehow

        await testCase.run();

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
                missClient.transaction().receivedEverything().then(async () => {
                    await this.dut.finishCaching(); }),
                "wait for the whole miss response to reach the 1st client and " +
                "also get cached by the proxy");
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


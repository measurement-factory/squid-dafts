/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

/* Tests whether an HTTP proxy caches a response
 * Parameters: [drop-Content-Length] [body size] */

//import Promise from "bluebird";
import Promise from "bluebird";
import ProxyCase from "./ProxyCase";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import * as Gadgets from "../src/misc/Gadgets";
import * as Config from "../src/misc/Config";
import * as AddressPool from "../src/misc/AddressPool";
import * as Http from "../src/http/Gadgets";
import StartTests from "../src/misc/TestRunner";
import { Must } from "../src/misc/Gadgets";
import assert from "assert";

const BasePort = Config.ProxyListeningAddress.port;
const Host = Config.ProxyListeningAddress.host;
const AddrLimit = 8;
let ProxyListeningAddresses = [];
for (let i = 0; i < AddrLimit; ++i) {
    ProxyListeningAddresses.push({host: Host, port: BasePort + i});
}

Config.Recognize([
    {
        option: "requests",
        type: "Number",
        default: "4",
        description: "simultaneous requests number (>1 && <="+AddrLimit,
    },
    {
        option: "workers",
        type: "Number",
        default: "4",
        description: "Squid workers number",
    },
]);

async function DoTest(args) {
    let resource = new Resource();
    resource.makeCachable();
    resource.uri.address = AddressPool.ReserveListeningAddress();
    resource.body = new Body(Gadgets.UniqueId("body-"));
    resource.finalize();

    const initiatorAddr = ProxyListeningAddresses[0];
    const smp = args.workers > 1;
    const collapseAddr = smp ? ProxyListeningAddresses[1] : ProxyListeningAddresses[0];

    // need this for pids checking for SMP
    let pids = [2];

    let collapseCase = new ProxyCase('collapse on the existing transaction', collapseAddr);
    collapseCase.client().request.for(resource);
    let requests = args.requests - 2;;
    if (requests > 0) {
        let proxyAddresses = [];
        for (let i = 2; i < args.workers; ++i) {
            proxyAddresses.push(ProxyListeningAddresses[i]);
            pids.push(i+1);
            if (--requests === 0)
                break;
        }
        while(requests > 0) {
            const lastPid = pids[pids.length-1];
            pids.push(lastPid);
            proxyAddresses.push(ProxyListeningAddresses[args.workers - 1]);
            requests--;
        }

        collapseCase.addClients(collapseCase.client(), args.requests - 2, proxyAddresses);
    }
    collapseCase.check(() => {
        let pidIdx = 0;
        for (let client of collapseCase.clients()) {
            assert(client.transaction().response, "Proxy must send a response");
            const collapseStatus = client.transaction().response.startLine.statusNumber();
            if (smp) {
                const pid = client.transaction().response.proxyPid();
                assert.equal(pid, pids[pidIdx], "expected worker pid");
                pidIdx++;
            }
            const collapseTag = client.transaction().response.tag();
            assert.equal(collapseStatus, 200, "expected response status code 200");
            assert.equal(collapseTag, "first", "Squid collapsed worker X-Daft-Response-Tag");
        }
    });


    let initiatorCase = new ProxyCase('initiate a transaction', initiatorAddr);
    initiatorCase.client().request.for(resource);
    initiatorCase.check(() => {
        assert(initiatorCase.client().transaction().response, "Proxy must send a response");
        initiatorCase.expectStatusCode(200);
        const initiatorPid = initiatorCase.client().transaction().response.proxyPid();
        const initiatorTag = initiatorCase.client().transaction().response.tag();
        assert.equal(initiatorTag, "first", "Squid collapsing initiator worker X-Daft-Response-Tag");
        let responseBody = initiatorCase.client().transaction().response.body.whole();
        assert.equal(responseBody, resource.body.whole(), "Served response body");
    });

    let serverCase = new ProxyCase('serve a response');
    serverCase.server().response.tag("first");
    serverCase.serverWillWaitForClients([collapseCase]);
    serverCase.server().serve(resource);

    let collapsePromise = null;
    serverCase.server().response.promiseToReceive().then(() => {
        serverCase.server().response.tag("second");
        serverCase.server().response.promiseToReceive(false);
        collapsePromise = collapseCase.run();
    });

    let serverPromise = serverCase.run();
    let initiatorPromise = initiatorCase.run();
    await initiatorPromise;
    assert(collapsePromise);
    await collapsePromise;
    await serverPromise;

    AddressPool.ReleaseListeningAddress(resource.uri.address);
}

async function Test(testRun, callback) {

    Must(Config.Requests > 1);

    await DoTest({workers: Config.Workers, requests: Config.Requests});

    console.log("Test result: success");
    if (callback)
        callback();
}

StartTests(Test);


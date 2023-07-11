/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

/* Tests whether an HTTP proxy caches a response
 * Parameters: [drop-Content-Length] [body size] */

import assert from "assert";
import HttpTestCase from "../src/test/HttpCase";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import ConfigGen from "../src/test/ConfigGen";
import * as Config from "../src/misc/Config";
import * as AddressPool from "../src/misc/AddressPool";
import Test from "../src/overlord/Test";

export default class MyTest extends Test {

    static Configurators() {
        const configGen = new ConfigGen();

        configGen.addGlobalConfigVariation({bodySize: [
            Config.DefaultBodySize(),

            0,
            1,
            Config.LargeBodySize(),
            Config.HugeCachableBodySize(),
        ]});

        configGen.addGlobalConfigVariation({responseEndsAtEof: [
            false,

            true,
        ]});

        configGen.addGlobalConfigVariation({dutMemoryCache: [
            false,
            true,
        ]});

        configGen.addGlobalConfigVariation({dutDiskCache: [
            // TODO: false, but exclude a false+false combo with dutMemoryCache
            true,
        ]});

        return configGen.generateConfigurators();
    }

    async run(/*testRun*/) {

        assert(Config.BodySize >= 0, "positive body-size"); // TODO: Add Size option type

        let resource = new Resource();
        resource.makeCachable();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.body = new Body();
        resource.finalize();

        let missCase = new HttpTestCase(`cache a response`);
        missCase.server().serve(resource);
        missCase.client().request.for(resource);
        missCase.addMissCheck();
        await missCase.run();

        await this.dut.finishCaching();

        let hitCase = new HttpTestCase(`hit the cached response`);
        hitCase.client().request.for(resource);
        hitCase.addHitCheck(missCase.server().transaction().response);
        await hitCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

}

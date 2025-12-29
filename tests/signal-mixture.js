/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

// Tests whether an HTTP proxy properly handles a mixture of reconfiguration and shutdown commands

import assert from "assert";
import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import Test from "../src/overlord/Test";
import { FlexibleConfigGen } from "../src/test/ConfigGen";

Config.Recognize([
    {
        option: "workers",
        type: "Number",
        description: "the number of Squid worker processes",
    },
    {
        option: "signal-list",
        type: "String",
        description: "the list of signals to be sent to Squid",
    },
    {
        option: "smooth-reconfiguration",
        type: "Boolean",
        description: "whether start in smooth reconfiguration mode",
    },
]);

export default class MyTest extends Test {
    static Configurators() {
        const configGen = new FlexibleConfigGen();

        configGen.workers(function *() {
            yield 1;
            yield 4;
        });

        configGen.smoothReconfiguration(function *() {
            yield false;
            yield true;
        });

        configGen.signalList(function *() {
            yield "HUP, HUP";
            yield "HUP, INT";
            yield "HUP, HUP, HUP, HUP, HUP";
            yield "INT, HUP, HUP, HUP, HUP";
        });

        return configGen.generateConfigurators();
    }

    constructor() {
        super(...arguments);
        this._signals = Config.signalList().split(/[ ,]+/);
    }
    
    _configureDut(cfg) {
        cfg.workers(Config.workers());
        cfg.memoryCaching(true);
        cfg.diskCaching(false);
        if (Config.smoothReconfiguration())
            cfg.custom("reconfiguration smooth");
        this._workerListeningAddresses = cfg.workerListeningAddresses();
    }

    _expectedReconfigurationsMin() {
        if (this._signals.includes("HUP"))
            return 0;
        return (Config.workers() === 1) ? 1 : Config.workers() + 1; // workers plus coordinator, no diskers
    }

    _expectedReconfigurationsMax() {
        const hupSignals = this._signals.filter(el => el === 'HUP').length;
        return (Config.workers() === 1) ? hupSignals : hupSignals*(Config.workers()+1);
    }

    async run(/*testRun*/) {
        this._serverAddress = AddressPool.ReserveListeningAddress();
        const stats = await this.dut.sendSignals(Config.signalList());
        assert(stats.reconfiguringHarshlyLines >= this._expectedReconfigurationsMin());
        assert(stats.reconfiguringHarshlyLines <= this._expectedReconfigurationsMax());
        AddressPool.ReleaseListeningAddress(this._serverAddress);
    }
}

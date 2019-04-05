import Promise from "bluebird";
import * as Config from "../src/misc/Config";
import * as AddressPool from "../src/misc/AddressPool";
import HttpTestCase from "../src/test/HttpCase";
import * as Gadgets from "../src/misc/Gadgets";
import assert from "assert";
import Test from "../src/test/Test";
import ProxyOverlord from "../src/overlord/Proxy";

/* for time conversion to milliseconds */
const milliseconds = 1;

// TCP step delays are configured in StepSize increments to reduce the
// number of IP addresses needed to support all configurable delays.
const StepSize = 40*milliseconds;

// custom CLI options
Config.Recognize([
    {
        option: "cases",
        type: "[String]",
        default: "[]",
        description: "limit test cases to these comma-separated domain names",
    },
]);

// A problem with (randomly generated) sequence of steps
// rather than, say, a TypeError caught by the interpreter.
// TODO: This class is not an Error child because Babel does not support
// subclassing of built-in types like Error. Switch from Babel to native
// node v8 and add replace with "class GenError extends Error {}".
class GenError { // extends Error
    // declare a nothing-but-forwarding constructor
    // to enable "instanceof GenError" checks
    constructor(message) {
        this.message = message;
    }

    toString() {
        return this.message;
    }
}

// a DNS query or a TCP probe for an IPv4 or IPv6 address
class Step {
    constructor(family) {
        assert(arguments.length === 1);
        assert(family === 0 || family === 4 || family === 6);
        this.family_ = family;
        this.wait_ = 0; // walker waits that long to start this step
        this.delay_ = 0; // this step takes that long (from start) to finish
        /* Do not forget to update sync_() when updating fields */
    }

    family() {
        return this.family_;
    }

    isSpare() {
        return this.family_ === 0;
    }

    isIp4() {
        return this.family_ === 4;
    }

    isIp6() {
        return this.family_ === 6;
    }

    wait() {
        assert(arguments.length === 0);
        return this.wait_;
    }

    delay() {
        assert(arguments.length === 0);
        return this.delay_;
    }

    // No more same-family steps are necessary/expected after this one.
    // In other words, this step should lead to an HTTP transaction.
    final() {
        // a pure virtual method
        const kidType = Object.getPrototypeOf(this).constructor.name;
        assert(false, `Missing ${kidType}::final()`);
    }

    domainLabel() {
        // a pure virtual method
        const kidType = Object.getPrototypeOf(this).constructor.name;
        assert(false, `Missing ${kidType}::domainLabel()`);
    }

    setWait(wait) {
        assert(arguments.length === 1);
        assert(wait > 0 || wait === 0);
        this.wait_ = wait;
        this.delay_ = 0;
    }

    setDelay(delay) {
        assert(arguments.length === 1);
        assert(delay > 0 || delay === 0);
        this.delay_ = delay;
        this.wait_ = 0;
    }

    setWaitAndDelay(wait, delay) {
        assert(arguments.length === 2);
        this.setWait(wait); // checks wait
        this.setDelay(delay); // checks delay but also zeroes way
        this.wait_ = wait; // already checked
    }
    toString() {
        return this.domainLabel();
    }

    labelPrefix_() {
        return (!this.delay()) ? "" : `pause${this.delay()}-`;
    }

    clone() {
        // a pure virtual method
        const kidType = Object.getPrototypeOf(this).constructor.name;
        assert(false, `Missing ${kidType}::clone()`);
    }

    // post-clone() synchronization for kids
    sync_(other) {
        this.wait_ = other.wait_;
        this.delay_ = other.delay_;
        return this;
    }
}

// a DNS query step
class DnsStep extends Step {
    constructor(family) {
        super(family);
    }

    clone() {
        return new DnsStep(this.family()).sync_(this);
    }

    final() {
        return false;
    }

    domainLabel() {
        return this.labelPrefix_() + "a" + this.family();
    }

}

// a TCP probe step
class TcpStep extends Step {
    constructor(family, failure) {
        assert(arguments.length === 2);
        super(family);
        this.failure_ = failure;
    }

    clone() {
        return new TcpStep(this.family(), this.failed()).sync_(this);
    }

    final() {
        return !this.failed();
    }

    failed() {
        return this.failure_;
    }

    domainLabel() {
        return this.labelPrefix_() + this.labelSuffix_();
    }

    ip() {
        const slotIdx = this.slotIdx_();
        const ips = {
            up4: `127.0.${slotIdx}.10`,
            down4: `127.0.${slotIdx}.11`,
            up6: `fc00::${slotIdx}:10`,
            down6: `fc00::${slotIdx}:11`,
        };
        const address = ips[this.labelSuffix_()];
        assert(address);
        return address;
        // If we are ever called for non-final labels, we should return
        // two different IPs when a family has two identical labels.
    }

    slotIdx_() {
        const idx = Math.floor((this.delay() + StepSize - 1*milliseconds) / StepSize);
        assert(idx >= 0);
        return idx;
    }

    labelSuffix_() {
        return (this.failure_ ? "down" : "up") + this.family();
    }
}


// manages computation of the winning Step IPs and response times
// a sequence of same-family Steps (prime or spare)
class FamilySteps {
    constructor(dnsStep, tcpSteps) {
        assert(arguments.length === 2);
        this.dnsStep_ = dnsStep;
        this.tcpSteps_ = tcpSteps;
    }

    // family ID
    family() {
        return this.dnsStep_.family();
    }

    dnsStep() {
        return this.dnsStep_;
    }

    tcpSteps() {
        return this.tcpSteps_;
    }

    allSteps() {
        return [this.dnsStep_, ...this.tcpSteps_];
    }

    // no steps after the final() step
    useful() {
        const idx = this.findFinalStepIndex_();
        const isUseful = idx < 0 || idx === (this.tcpSteps_.length - 1);
        // if (isUseful)
        //     console.log("useful  family:", this.toString());
        // else
        //     console.log("useless family:", this.toString(), "idx:", idx, "tcpSteps:", this.tcpSteps_.length);
        return isUseful;
    }

    // contains a final TCP step
    hasFinal() {
        return this.findFinalStepIndex_() >= 0;
    }

    findFinalStep() {
        const idx = this.findFinalStepIndex_();
        return (idx < 0) ? undefined : this.tcpSteps_[idx];
    }

    findFinalStepIndex_() {
        return this.tcpSteps_.findIndex(step => step.final());
    }

    toString() {
        const dns = this.dnsStep_.domainLabel();
        if (this.tcpSteps_.length)
            return dns + '.' + this.tcpSteps_.map(s => s.domainLabel()).join('.');
        else
            return dns;
    }
}


class HappyCase extends HttpTestCase {
    constructor(walk, gist, leadingSteps) {
        assert(arguments.length === 3);
        assert(leadingSteps.length >= 3); // p0, s0, and a winning TCP step

        super(gist); // description to be refined below
        this.walk = walk;

        /* computed by findWinner_() */
        this.winner_ = null;
        this.minResponseTime_ = null;
        this.allSteps_ = null;
        this.findWinner_(leadingSteps);

        this.gist = `${this.winner_.domainLabel()} wins in ${this.domainName()} # ${gist}`;
    }

    winner() {
        assert(this.winner_);
        return this.winner_;
    }

    minResponseTime() {
        assert(this.minResponseTime_ !== null);
        return this.minResponseTime_;
    }

    domainName() {
        return this.toString() + ".happy.test";
    }

    commitStep_(template) {
        assert(template);
        const step = template.clone();
        this.allSteps_.push(step);

        if (step.final()) {
            assert(!this.winner_);
            this.winner_ = step;
        }
    }

    // Finds the first final() step and
    // calculates the time it would take to reach that step.
    findWinner_(leadingSteps) {
        this.allSteps_ = [];
        for (const step of leadingSteps) {
            if (step instanceof DnsStep) {
                this.commitStep_(step);
            } else {
                assert(step instanceof TcpStep);
                if (step.family() === this.walk.primeFamily_.dnsStep().family())
                    this.walk.primeFamily_.tcpSteps().forEach(s => this.commitStep_(s));
                else
                    this.walk.spareFamily_.tcpSteps().forEach(s => this.commitStep_(s));
            }
        }
        assert(this.winner_);

        this.minResponseTime_ = 0;
        const winnerFamily = this.winner_.family();
        for (const step of this.allSteps_) {
            if (step.family() !== winnerFamily)
                continue;
            this.minResponseTime_ += step.wait();
            this.minResponseTime_ += step.delay();
        }
    }

    toString() {
        return this.allSteps_.map(s => s.domainLabel()).join('.');
    }
}

// A complete sequence of test case steps:
// two DNS queries and TCP probing steps for the IPs returned by those queries.
// * primary DNS step
// * first TCP steps
// * secondary DNS step
// * last TCP steps, starting with a middle TCP step (firstFamilyAfterSpare)
class Walk {
    constructor(primeFamilyId) {
        assert(arguments.length === 1);
        this.primeFamilyId_ = primeFamilyId;
        this.clear();
    }

    clear() {
        this.spareFamily_ = null;
        this.firstTcpSteps_ = null;
        this.firstFamilyAfterSpare_ = null;
        this.lastTcpSteps_ = [];
        this.winningPath_ = null;
    }

    setPrime(primeFamily) {
        this.clear();
        this.primeFamily_ = primeFamily;
        return primeFamily.useful();
    }

    setSpare(spareFamily) {
        this.spareFamily_ = spareFamily;
        if (!spareFamily.useful())
            return false; // useless prime family

        return this.primeFamily_.hasFinal() !== this.spareFamily_.hasFinal();
    }

    allSteps_() {
        let result = [];
        if (this.primeFamily_)
            result = result.concat(this.primeFamily_.allSteps());
        if (this.spareFamily_)
            result = result.concat(this.spareFamily_.allSteps());
        return result;
    }

    domainName() {
        const path = this.winningPath();
        return path.allSteps.map(s => s.domainLabel()).join('.') + ".happy.test";
    }

    useful() {
        return this.primeFamily_.hasFinal() || this.spareFamily_.hasFinal();
    }

    winningPath() {
        if (this.winningPath_ === null) {
            this.winningPath_ = this.findWinningPath_();
        }
        assert(this.winningPath_);
        return this.winningPath_;
    }

    *testCases() {
        // SW: the moment when the Spare connection gap Wait is over
        // p0: prime DNS step
        // s0: spare DNS step
        // p1: the first prime TCP step
        // s1: the first spare TCP step

        // time sufficient for all same-family TCP steps to complete
        const FamilyDelay = 3*StepSize;

        // when the proxy normally launches the spare transaction (SW)
        const SpareWaitExact = 250*milliseconds;

        // a minimal delay that would place a TCP step after SW
        // as any TCP step delay, this should be divisible by StepSize
        const SpareWaitDelay = StepSize * Math.floor((SpareWaitExact + StepSize - 1*milliseconds) / StepSize);
        assert(SpareWaitDelay > SpareWaitExact);

        // s1 delay in test case "p0 s0 SW p1+ s1+" below depends on this
        assert(SpareWaitDelay - SpareWaitExact <= StepSize);

        this.allSteps_().forEach(s => s.setDelay(0));

        const p0 = this.primeFamily_.dnsStep();
        const s0 = this.spareFamily_.dnsStep();

        let leaders = null;

        /* cases without primary IPs */
        if (!this.primeFamily_.tcpSteps().length) {
            const s1 = this.spareFamily_.tcpSteps()[0];

            // Enumerate SW positions: p0 __ s0 __ s1+ __
            leaders = [p0, s0, s1];

            s0.setDelay(SpareWaitExact);
            s1.setDelay(0);
            yield new HappyCase(this, "p0 SW s0 s1+", leaders);

            s0.setDelay(StepSize);
            s1.setDelay(SpareWaitDelay - StepSize);
            yield new HappyCase(this, "p0 s0 SW s1+", leaders);

            s0.setDelay(StepSize);
            s1.setDelay(0);
            yield new HappyCase(this, "p0 s0 s1+ SW", leaders);

            return; // no other meaningful combinations
        }

        const p1 = this.primeFamily_.tcpSteps()[0];

        /* cases without spare IPs */
        if (!this.spareFamily_.tcpSteps().length) {
            // Enumerate SW positions: p0 __ s0 __ p1+ __
            leaders = [p0, s0, p1];

            s0.setDelay(SpareWaitExact);
            p1.setDelay(SpareWaitDelay + StepSize);
            yield new HappyCase(this, "p0 SW s0 p1+", leaders);

            s0.setDelay(StepSize);
            p1.setDelay(SpareWaitDelay);
            yield new HappyCase(this, "p0 s0 SW p1+", leaders);

            s0.setDelay(StepSize);
            p1.setDelay(StepSize + StepSize);
            yield new HappyCase(this, "p0 s0 p1+ SW", leaders);


            // Enumerate SW positions: p0 __ p1+ __ s0 __
            leaders = [p0, p1, s0];

            p1.setDelay(SpareWaitDelay);
            s0.setDelay(SpareWaitDelay + StepSize);
            yield new HappyCase(this, "p0 SW p1+ s0", leaders);

            p1.setDelay(0);
            s0.setDelay(SpareWaitExact);
            yield new HappyCase(this, "p0 p1+ SW s0", leaders);

            p1.setDelay(0);
            s0.setDelay(StepSize + StepSize);
            yield new HappyCase(this, "p0 p1+ s0 SW", leaders);

            return; // no other meaningful combinations
        }

        const s1 = this.spareFamily_.tcpSteps()[0];

        /* cases with prime and spare IPs */

        // Enumerate p1+ positions: p0 __ s0 __ s1+ __

        // Enumerate SW positions: p0 __ p1+ __ s0 __ s1+ __
        leaders = [p0, p1, s0, s1];

        p1.setDelay(SpareWaitDelay);
        s0.setDelay(SpareWaitDelay + StepSize);
        s1.setDelay(0);
        yield new HappyCase(this, "p0 SW p1+ s0 s1+", leaders);

        p1.setDelay(0);
        s0.setDelay(SpareWaitExact);
        s1.setDelay(0);
        yield new HappyCase(this, "p0 p1+ SW s0 s1+", leaders);

        p1.setDelay(0);
        s0.setDelay(StepSize + StepSize);
        s1.setDelay(SpareWaitDelay);
        yield new HappyCase(this, "p0 p1+ s0 SW s1+", leaders);

        p1.setDelay(0);
        s0.setDelay(StepSize + StepSize);
        s1.setDelay(0);
        yield new HappyCase(this, "p0 p1+ s0 s1+ SW", leaders);


        // Enumerate SW positions: p0 __ s0 __ p1+ __ s1+ __
        leaders = [p0, s0, p1, s1];

        s0.setDelay(SpareWaitExact);
        p1.setDelay(SpareWaitDelay + StepSize);
        s1.setDelay(StepSize + StepSize);
        yield new HappyCase(this, "p0 SW s0 p1+ s1+", leaders);

        s0.setDelay(StepSize);
        p1.setDelay(SpareWaitDelay);
        s1.setWaitAndDelay(SpareWaitExact - s0.delay(), StepSize + StepSize);
        yield new HappyCase(this, "p0 s0 SW p1+ s1+", leaders);

        s0.setDelay(StepSize);
        p1.setDelay(StepSize + StepSize);
        s1.setWaitAndDelay(p1.delay() - s0.delay(), SpareWaitDelay - p1.delay());
        yield new HappyCase(this, "p0 s0 p1+ SW s1+", leaders);

        s0.setDelay(StepSize);
        p1.setDelay(StepSize + StepSize);
        s1.setWait(p1.delay() - s0.delay());
        yield new HappyCase(this, "p0 s0 p1+ s1+ SW", leaders);


        // Enumerate SW positions: p0 __ s0 __ s1+ __ p1+ __
        leaders = [p0, s0, s1, p1];

        s0.setDelay(SpareWaitExact);
        s1.setDelay(0);
        p1.setDelay(SpareWaitDelay + FamilyDelay);
        yield new HappyCase(this, "p0 SW s0 s1+ p1+", leaders);

        s0.setDelay(StepSize);
        s1.setWait(SpareWaitExact - s0.delay());
        p1.setDelay(SpareWaitDelay + FamilyDelay);
        yield new HappyCase(this, "p0 s0 SW s1+ p1+", leaders);

        // impossible
        // s0.setDelay(StepSize);
        // s1.setDelay(0);
        // p1.setDelay(SpareWaitDelay);
        // yield new HappyCase(this, "p0 s0 s1+ SW p1+", leaders);

        // impossible
        // s0.setDelay(StepSize);
        // s1.setWait(0);
        // p1.setDelay(FamilyDelay);
        // yield new HappyCase(this, "p0 s0 s1+ p1+ SW", leaders);
    }

    // Finds the first final() step and
    // calculates the time it would take to reach that step.
    findWinningPath_() {
        const primeSteps = this.primeFamily_.allSteps();
        const spareSteps = this.spareFamily_.allSteps();
        let primeRptm = 0;
        let spareRptm = 0;
        let winningStep = null;
        let sortedSteps = [];
        while (primeSteps.length || spareSteps.length) {
            const primeDelay = primeSteps.length ? primeSteps[0].delay() : Number.MAX_VALUE / 2;
            const spareDelay = spareSteps.length ? spareSteps[0].delay() : Number.MAX_VALUE / 2;
            let step = null;
            if (primeRptm + primeDelay <= spareRptm + spareDelay) {
                primeRptm += primeDelay;
                step = primeSteps.shift();
            } else {
                spareRptm += spareDelay;
                step = spareSteps.shift();
            }
            assert(primeRptm !== spareRptm || primeRptm === 0);
            sortedSteps.push(step);
            if (step.final() && !winningStep) {
                winningStep = step;
                // continue so that we fill sortedSteps
            }
        }
        assert(winningStep);

        return {
            description: winningStep.domainLabel(),
            ip: winningStep.ip(),
            family: winningStep.family(),
            minResponseTime: Math.min(primeRptm, spareRptm),
            allSteps: sortedSteps,
        };
    }

    toString() {
        return this.allSteps_().map(s => s.domainLabel()).join('.');
    }
}

function *makeTcpSteps(family) {
    yield new TcpStep(family, false);
    yield new TcpStep(family, true);
}


function *makeFamilySteps(family) {

    const dnsStep = new DnsStep(family);

    // Family with no IPs.
    yield new FamilySteps(dnsStep, []);

    // Family with a single IP.
    for (const tcpStep of makeTcpSteps(family)) {
        yield new FamilySteps(dnsStep, [tcpStep]);
    }

    // Family with two IPs.
    for (const tcpStep1 of makeTcpSteps(family)) {
        for (const tcpStep2 of makeTcpSteps(family)) {
            yield new FamilySteps(dnsStep, [tcpStep1, tcpStep2]);
        }
    }
}

function makeTestCases() {
    let plannedCases = [];
    let supportedCases = [];
    let orderedCases = new Map(Config.Cases.map((domain) => [domain.toLowerCase(), false]));

    for (const primeFamilyId of [4, 6]) {
        let walk = new Walk(primeFamilyId);

        for (const primeFamily of makeFamilySteps(primeFamilyId)) {
            const allowPrime = walk.setPrime(primeFamily);
            if (!allowPrime)
                continue;

            const spareFamilyId = (primeFamilyId === 4) ? 6 : 4;
            for (const spareFamily of makeFamilySteps(spareFamilyId)) {
                const allowSpare = walk.setSpare(spareFamily);
                if (!allowSpare)
                    continue;

                for (let testCase of walk.testCases()) {
                    assert(testCase instanceof HappyCase);
                    const domainName = testCase.domainName();
                    const context = domainName;
                    try {
                        supportedCases.push(domainName);

                        if (orderedCases.size) {
                            if (!orderedCases.has(domainName.toLowerCase()))
                                throw new GenError("not ordered");
                            orderedCases.set(domainName.toLowerCase(), true);
                        }
                        console.log("plan:", domainName, testCase.gist);
                        plannedCases.push(testCase);
                    } catch (err) {
                        if (!(err instanceof GenError))
                            throw err;

                        console.log(`rejecting ${context} for ${err}`);
                    }
                }
            }
        }
    }

    const supportedCasesStr = supportedCases.join("\n");
    orderedCases.forEach((found, domainName) => {
        assert(found, `--cases case ${domainName} is not one of the following ${supportedCases.length} supported test cases:\n${supportedCasesStr}`);
    });

    assert(plannedCases.length, "no test cases planned?!");
    return plannedCases;
}

export default class MyTest extends Test {
    constructor(...args) {
        super(...args);
        this.plannedCases = null; // TBD
        this.proxy = new ProxyOverlord();
    }

    async startup() {
        await this.proxy.start();
    }

    async shutdown() {
        await this.proxy.stop();
    }

    async run(testRun) {
        // XXX: Re-generating all test cases for each test run.
        // TODO: Split HappyCase away from HttpTestCase to make it reusable.
        this.plannedCases = makeTestCases();
        assert(this.plannedCases);

        // Hack: We rely on zero-TTL DNS records. Some proxies ignore zero TTLs when
        // collapsing DNS queries. To reduce collapsing, delay N+1 tests.
        // TODO: Use .runN.test suffix (for concurrent tests?).
        console.log(new Date().toISOString(), "Planned test run", testRun);
        await new Promise(resolve => setTimeout(resolve, (testRun.id - 1) * 5000 * milliseconds));
        console.log(new Date().toISOString(), "Actually starting test run", testRun);

        for (let testCase of this.plannedCases) {
            const winner = testCase.winner();

            // TODO: Add and use AddressPool.ReserveListeningPort() instead.
            const addressForPort = AddressPool.ReserveListeningAddress();
            const port = addressForPort.port;

            testCase.client().request.startLine.uri.address = {
                host: testCase.domainName(),
                port: port
            };
            testCase.server().listenAt({
                host: winner.ip(),
                port: port
            });
            testCase.check(() => {
                const plannedFamily = "IPv" + winner.family();
                const actualFamily = Gadgets.HostFamilyString(testCase.server().transaction().response.generatorAddress().host);
                assert.equal(actualFamily, plannedFamily, `used faster ${plannedFamily} path`);

                const plannedDelay = new Date(testCase.minResponseTime() * milliseconds);
                const actualDecisionDelay = new Date(testCase.server().transaction().startTime() - testCase.client().transaction().sentTime());
                const actualTotalDelay = testCase.runtime();
                console.log(`connected in ${actualDecisionDelay.getTime()} vs. expected minimum of ${plannedDelay.getTime()} milliseconds`);
                console.log(`test case took ${actualTotalDelay.getTime()} vs. expected minimum of ${plannedDelay.getTime()} milliseconds`);

                const allowedDelta = 2000 * milliseconds; // XXX 20 * StepSize * 0.90;
                assert(actualDecisionDelay.getTime() > (plannedDelay.getTime()), "honored delays");
                assert(actualDecisionDelay.getTime() < (plannedDelay.getTime() + allowedDelta), "finished ASAP");
            });
            await testCase.run();

            AddressPool.ReleaseListeningAddress(addressForPort);
        }
    }

}

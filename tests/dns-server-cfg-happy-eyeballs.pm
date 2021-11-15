# Daft-based Squid Tests
# Copyright (C) The Measurement Factory.
# http://www.measurement-factory.com/

$SummarizeEachTransaction = 1;

$main::ForwardingAddresses = [ qw(8.8.8.8) ];

my %IpEndingByState = (
    'up' => 10,
    'down' => 11,
);

use constant LastSlot => 20;
# all delays are in (fractional) seconds
use constant milliseconds => 1e-3;
use constant SlotSize => 40 * milliseconds;

# 127.0.0.10 ... 127.0.7.11
# fc00::0:10 ... fc00::7:11
sub MakeIp {
    die() unless @_ == 3;
    my ($family, $state, $slot) = @_;

    my $end = $IpEndingByState{$state};
    die("unknown happy.test IP state: $state; stopped") unless defined $end;

    return "127.0.${slot}.$end" if $family == 4;
    return "fc00::${slot}:$end" if $family == 6;
    die("unknown happy.test IP family: $family; stopped");
}

sub delayInSlots {
    my $delay = shift;
    return int(($delay + + SlotSize - 1*milliseconds)/SlotSize);
}

# a4.a6.up6.to250ms.happy.test
$main::ZoneMaker = sub {
    my ($rawQname) = @_;
    return undef() unless $rawQname =~ /^(?:ign\w*)?(.+)([.]happy[.]test)$/i;
    my $left = $1;
    my $qname = $1 . $2;

    my $families = {
        4 => {
            answer => IpAnswer->new(),
        },
        6 => {
            answer => IpAnswer->new(),
        },
    };

    my $labelIdx = 0;
    while ($left =~ /([^.]+)/g) {
        my $label = $1;
        ++$labelIdx;
        #warn("studying $label in $qname\[$labelIdx\]");

        my $buf = $label;

        die("$label in $qname\[$labelIdx\] lacks IP family; stopped") unless $buf =~ s/(4|6)$//;
        my $familyId = $1;

        my $family = $families->{$familyId};
        die("$label in $qname\[$labelIdx\] has unsupported IP family $familyId; stopped") unless defined $family;

        my $delay = ($buf =~ s/^pause(\d+)-//) ? $1 * milliseconds: 0;

        my $action = $buf;

        # DNS
        if ($action eq "a") {
            $family->{answer}->configureDelay($delay);
            next;
        }

        # TCP
        if ($action eq "up" || $action eq "down") {
            # XXX: Repeated domain name labels yield repeated IPs in the answer.
	        # For example, two identical IPv4s in a4.down4.down4.a6.up6.happy.test.
	        my $slotIdx = &delayInSlots($delay);
	        my $ip = &MakeIp($familyId, $action, $slotIdx);
	        die("$label in $qname\[$labelIdx\] lacks IP; stopped") unless defined $ip;
	        $family->{answer}->addIp($ip);
	        next;
	    }

	    die("$label in $qname\[$labelIdx\] has unknown action $action; stopped");
    }

    return {
        A => $families->{4}->{answer},
        AAAA => $families->{6}->{answer},
    };
};

sub run {
    my ($cmd, %options) = @_;

    print("$cmd\n");
    $cmd =~ s@\s*\n\s*@ @g;

    my $output = `$cmd 2>&1`;
    return if $options{runOutputIsIrrelevant};

    if (length $output) {
        print($output);
        my $delimiter = ($output =~ /\n$/s) ? "" : "\n";
        print($delimiter);
        return if $options{runOutputIsExpected};
        die("The command above failed; stopped") unless $options{runErrorIsSalvaged};
        warn("The command above failed; salvaged");
    }
}

sub reset {
    my %delOptions = (
        runOutputIsIrrelevant => 1,
    );

    my %testOptions = (
        runOutputIsExpected => 1,
    );

    # configure IP addresses and associated tc-based delays

    &run("tc qdisc del dev lo root", %delOptions);
    &run("tc qdisc add dev lo root handle 1: htb");

    # we really want unlimited rate, but tc htb does not support that
    # explicitly, and we still get "overlimits" with this approximation
    my $htb = "htb rate 10Gbps burst 1Mb cburst 1Mb";

    # base class; all the classes below are its children
    &run("tc class add dev lo parent 1: classid 1:1 $htb");

    foreach my $slotIdx (0..LastSlot) {
        my $classIdx = $slotIdx + 1;
        my $classId = "1:$classIdx";
        my $netemDelay = SlotSize * $slotIdx;

        if ($netemDelay) {
            &run("tc class add dev lo parent 1:1 classid $classId $htb");
            # delay packets that fall into the above class
            &run("tc qdisc add dev lo parent $classId handle ${classIdx}: netem delay ${netemDelay}s");
        }

        foreach my $state (qw(up down)) {
            {
                my $ip = &MakeIp(4, $state, $slotIdx);
                &run("ip -4 address del $ip/32 dev lo", %delOptions);
                &run("ip -4 address add $ip/32 dev lo");

                # 0x02 at byte 33 (for IPv4) is (usually) the TCP SYN flag
                &run("tc filter add dev lo parent 1:0 protocol ip u32
                    match ip protocol 6 0xFF
                    match u8 0x02 0xFF at 33
                    match ip dst $ip/32
                    flowid $classId") if $netemDelay;

                &run("/usr/bin/time --format '%e seconds' nc -n4 $ip 8080", %testOptions)
                    if $slotIdx == 0; # minimize delays by testing fewer IPs
            }

            {
                my $ip = &MakeIp(6, $state, $slotIdx);
                &run("ip -6 address del $ip/128 dev lo", %delOptions);
                &run("ip -6 address add $ip/128 dev lo");

                # 0x02 at byte 53 (for IPv6) is (usually) the TCP SYN flag
                # an ip6 fc00::20/127 prefix length-based mask was ignored in my tests
                &run("tc filter add dev lo parent 1:0 protocol ipv6 u32
                    match ip6 protocol 6 0xFF
                    match u8 0x02 0xFF at 53
                    match ip6 dst $ip/128
                    flowid $classId") if $netemDelay;

                &run("/usr/bin/time --format '%e seconds' nc -n6 $ip 8080", %testOptions)
                    if $slotIdx == LastSlot; # minimize delays by testing fewer IPs
            }
        }
    }

    &run("tc -s qdisc show | grep -w -A2 lo", %testOptions);
}

$main::Prep = sub {
    &reset();
};

1;

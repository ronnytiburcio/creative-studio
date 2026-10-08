#!/usr/bin/env bash
# Leak grep: finds owner / business data in files that may be published (the Phase 4 export gate reuses it).
#
#   scripts/leak-grep.sh [--deny FILE] [--allow FILE] [--root DIR] [--quiet] PATH...
#
# PATH = files or folders, relative to --root (default: the repo root). Folders are walked recursively; node_modules,
# .next and .git are skipped. Every file is scanned line by line (binary files too, as bytes).
#
# --deny FILE   the denylist (default <repo>/private/leak-denylist.txt; it is private because it names the owner's
#               clients). One Perl regex per line, case-insensitive; a "c:" prefix makes a line case-sensitive; blank
#               lines and lines starting with # are ignored.
# --allow FILE  exact allowed leftovers (default <repo>/scripts/leak-allow.txt). One entry per line:
#                 <token><TAB><path>[<TAB># reason]
#               <token> = the matched text (compared lowercase) or "sha256:<hex>" of the lowercase matched text, so the
#               public allowlist never has to spell out a private word. <path> = the file's path relative to --root.
#
# Prints "path:line: matched text" per hit, then a summary. Exit 0 = no hits, 1 = hits, 2 = usage / missing denylist.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
deny="$repo/private/leak-denylist.txt"
allow="$repo/scripts/leak-allow.txt"
root="$repo"
quiet=0
paths=()
while [ $# -gt 0 ]; do
  case "$1" in
    --deny) deny="$2"; shift 2 ;;
    --allow) allow="$2"; shift 2 ;;
    --root) root="$2"; shift 2 ;;
    --quiet) quiet=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) paths+=("$1"); shift ;;
  esac
done
if [ ${#paths[@]} -eq 0 ]; then echo "leak-grep: no paths given (see --help)" >&2; exit 2; fi
if [ ! -f "$deny" ]; then echo "leak-grep: denylist not found: $deny" >&2; exit 2; fi
[ -f "$allow" ] || allow=/dev/null

cd "$root"
rc=0
LEAK_DENY="$deny" LEAK_ALLOW="$allow" LEAK_QUIET="$quiet" /usr/bin/perl -e '
use strict; use warnings; use File::Find; use Digest::SHA qw(sha256_hex);
my (@pats, %allow);
open(my $d, "<", $ENV{LEAK_DENY}) or die "leak-grep: cannot read the denylist\n";
while (my $l = <$d>) {
  chomp $l; $l =~ s/\r$//;
  next if $l =~ /^\s*(#|$)/;
  my $cs = ($l =~ s/^c://);
  push @pats, $cs ? qr/$l/ : qr/$l/i;
}
close $d;
open(my $a, "<", $ENV{LEAK_ALLOW}) or die "leak-grep: cannot read the allowlist\n";
while (my $l = <$a>) {
  chomp $l; $l =~ s/\r$//;
  next if $l =~ /^\s*(#|$)/;
  my ($tok, $path) = split /\t/, $l;
  die "leak-grep: allowlist line without a TAB separated path: $l\n" unless defined $path && length $path;
  $tok = lc $tok unless $tok =~ /^sha256:/;
  $allow{"$tok\t$path"} = 0;
}
close $a;
my @files;
for my $p (@ARGV) {
  die "leak-grep: not found: $p\n" unless -e $p;
  if (-d $p) {
    find({ no_chdir => 1, wanted => sub {
      if (-d $_ && m{(^|/)(node_modules|\.next|\.git)$}) { $File::Find::prune = 1; return; }
      push @files, $_ if -f $_;
    } }, $p);
  } else { push @files, $p; }
}
my ($hits, $allowed) = (0, 0);
for my $f (sort @files) {
  (my $rel = $f) =~ s{^\./}{};
  open(my $fh, "<:raw", $f) or next;
  my $n = 0;
  while (my $line = <$fh>) {
    $n++;
    for my $re (@pats) {
      while ($line =~ /$re/g) {
        my $m = $&;
        last if length($m) == 0;
        my $lc = lc $m;
        my $k1 = "$lc\t$rel"; my $k2 = "sha256:" . sha256_hex($lc) . "\t$rel";
        if (exists $allow{$k1} || exists $allow{$k2}) { $allowed++; $allow{exists $allow{$k1} ? $k1 : $k2}++; next; }
        $hits++;
        (my $show = $m) =~ s/[^\x20-\x7e]/?/g;
        print "$rel:$n: $show\n" unless $ENV{LEAK_QUIET};
      }
    }
  }
  close $fh;
}
my %scanned = map { (my $r = $_) =~ s{^\./}{}; ($r => 1) } @files;
my @unused = grep { $allow{$_} == 0 && $scanned{(split /\t/, $_)[1]} } sort keys %allow;
print STDERR "leak-grep: allowlist entry never matched (remove it): $_\n" for @unused;
printf "leak-grep: %d file(s), %d hit(s), %d allowed\n", scalar(@files), $hits, $allowed;
exit($hits ? 1 : 0);
' "${paths[@]}" || rc=$?
# 0 = clean, 1 = hits; anything else (a bad allowlist line, an unreadable file, a perl error) = 2.
if [ "$rc" -gt 1 ]; then exit 2; fi
exit "$rc"

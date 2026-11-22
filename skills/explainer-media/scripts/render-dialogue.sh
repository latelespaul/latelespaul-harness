#!/bin/zsh
# Render a two-host dialogue script to one MP3 with macOS `say` and ffmpeg.
#   render-dialogue.sh <script.txt> <out.mp3>
# Script format: one spoken line per text line, "A: words" or "B: words". A line "# ..." is a
# chapter mark (a longer pause, never spoken). Blank lines are ignored.
# Voices: VOICE_A and VOICE_B (defaults Rishi and Samantha; run `say -v '?'` for the list).
# TIMELINE=<file.tsv> also writes one row per line (start s, end s, speaker, text) for captions.
# Pauses: GAP (between lines, s, default 0.35) and CHAPTER_GAP (default 0.9). RATE = words per minute (default 175).
# Prints the output path and its length in seconds. Exit 1 on a missing tool, voice or bad line.
emulate -L zsh
setopt err_exit pipe_fail
die() { print -u2 "render-dialogue: $1"; exit 1 }
(( $# == 2 )) || die "usage: render-dialogue.sh <script.txt> <out.mp3>"
src=$1 out=$2
[[ -r $src ]] || die "cannot read $src"
for t in say ffmpeg ffprobe; do (( $+commands[$t] )) || die "$t not found (brew install ffmpeg)"; done
va=${VOICE_A:-Rishi} vb=${VOICE_B:-Samantha} rate=${RATE:-175}
voices=$(say -v '?')
for v in $va $vb; do print -r -- $voices | grep -q "^$v " || die "voice '$v' not installed (System Settings > Accessibility > Spoken Content)"; done

tmp=$(mktemp -d); trap 'rm -rf $tmp' EXIT
fmt=(-ar 44100 -ac 1 -c:a pcm_s16le)
ffmpeg -v error -f lavfi -i anullsrc=r=44100:cl=mono -t ${GAP:-0.35} $fmt $tmp/gap.wav
ffmpeg -v error -f lavfi -i anullsrc=r=44100:cl=mono -t ${CHAPTER_GAP:-0.9} $fmt $tmp/chap.wav
list=$tmp/list.txt; : > $list
typeset -F t=0; n=0 pending=
dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 $1 }
[[ -n $TIMELINE ]] && { mkdir -p ${TIMELINE:h}; : > $TIMELINE }
while IFS= read -r line || [[ -n $line ]]; do
  [[ -z ${line// } ]] && continue
  if [[ $line == \#* ]]; then pending=chap; continue; fi
  [[ $line =~ '^([AB]):[[:space:]]*(.+)$' ]] || die "bad line (need 'A: ...' or 'B: ...'): $line"
  who=$match[1] text=$match[2]
  (( ++n ))
  print -r -- $text > $tmp/$n.txt
  [[ $who == A ]] && v=$va || v=$vb
  say -v $v -r $rate -f $tmp/$n.txt -o $tmp/$n.aiff
  ffmpeg -v error -i $tmp/$n.aiff $fmt $tmp/$n.wav
  if (( n > 1 )); then
    print "file '$tmp/${pending:-gap}.wav'" >> $list
    (( t += $(dur $tmp/${pending:-gap}.wav) ))
  fi
  d=$(dur $tmp/$n.wav)
  [[ -n $TIMELINE ]] && printf '%.2f\t%.2f\t%s\t%s\n' $t $(( t + d )) $who $text >> $TIMELINE
  (( t += d ))
  print "file '$tmp/$n.wav'" >> $list
  pending=
done < $src
(( n )) || die "no spoken lines in $src"
mkdir -p ${out:h}
ffmpeg -v error -y -f concat -safe 0 -i $list -c:a libmp3lame -q:a 4 $out
secs=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $out)
print "$out ${secs%.*}s ($n lines)"

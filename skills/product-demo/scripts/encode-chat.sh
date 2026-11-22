#!/bin/zsh
# Encode a video for chat apps and social posts: H.264, yuv420p, AAC, +faststart.
#   encode-chat.sh <in.mp4> <out.mp4> [max-MB]
# Starts at CRF 23 and steps down the quality (then the size, to 720 px on the short side) until
# the file fits max-MB (default 50, the Telegram bot limit). Prints the path, size and length.
emulate -L zsh
setopt err_exit pipe_fail
die() { print -u2 "encode-chat: $1"; exit 1 }
(( $# >= 2 )) || die "usage: encode-chat.sh <in.mp4> <out.mp4> [max-MB]"
in=$1 out=$2 max=${3:-50}
[[ -r $in ]] || die "cannot read $in"
for t in ffmpeg ffprobe; do (( $+commands[$t] )) || die "$t not found (brew install ffmpeg)"; done
has_audio=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 $in)
audio=(-an); [[ -n $has_audio ]] && audio=(-c:a aac -b:a 128k)
mb() { print $(( $(stat -f %z $1) / 1048576.0 )) }
for crf scale in 23 '' 26 '' 29 '' 29 720 32 720; do
  vf=(); [[ -n $scale ]] && vf=(-vf "scale='if(gt(iw,ih),-2,$scale)':'if(gt(iw,ih),$scale,-2)'")
  ffmpeg -v error -y -i $in $vf -c:v libx264 -preset slow -crf $crf -pix_fmt yuv420p \
    -movflags +faststart $audio $out
  (( $(mb $out) <= max )) && break
done
size=$(mb $out)
(( size <= max )) || die "$(printf '%s is still %.1f MB (limit %s MB); shorten the video' $out $size $max)"
secs=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $out)
printf '%s %.1f MB %ss (crf %s%s)\n' $out $size ${secs%.*} $crf ${scale:+, ${scale}p}

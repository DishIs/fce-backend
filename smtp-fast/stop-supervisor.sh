#!/bin/bash

printf "READY\n";

while read line; do
  echo "Processing Event: $line" >&2;
  kill -3 $(cat "/supervisord.pid")
done < /dev/stdin

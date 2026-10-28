# Truthfulness review checklist

Give this to the reviewer (and to the lane before it starts). For every "no", ask for a reproducing test and fix red-first.

## Contract

- [ ] Every decision a view makes (attention, threshold reached, alerted, estimated) is a field in the read model's output type, computed once in the reader.
- [ ] No field merges two states that the UI would describe with different words.
- [ ] Each derived field's doc comment is a sentence the UI may say.
- [ ] Snapshots carry `generatedAt` from one trusted clock.

## Freshness and time

- [ ] Freshness is derived by the reader (fresh / stale / ended); producers never send "stale".
- [ ] Status and freshness are shown together; nothing is labelled "live".
- [ ] Polled views age on the client clock and turn stale without a new snapshot.
- [ ] Server-rendered or read-once views show absolute times with a time zone, not "N ago".
- [ ] One shared time component is used for signal and report times.
- [ ] A failed refresh keeps the data and shows "not current" plus the last confirmed time.
- [ ] Every request has a timeout; the next poll is always scheduled.

## Side effects and numbers

- [ ] "Sent / emailed / delivered" appear only for a recorded success; pending, failed and gave-up states have words.
- [ ] Decisions use exact arithmetic; displayed values are floored so they cannot cross a threshold.
- [ ] Badges use the decision field, not the rounded display value.
- [ ] Estimated values say "estimated" everywhere, including emails and table captions.
- [ ] No zero is shown for "nothing reported"; no chart of zeros is presented as measured.

## Tests

- [ ] Window boundary table (inside, exact, outside) and ended-vs-stale cases exist in the reader tests.
- [ ] Component tests with fake timers cover ageing, failed refresh and hung request.
- [ ] A static or rendered-text test forbids "live" on values and requires "estimated" on costs.

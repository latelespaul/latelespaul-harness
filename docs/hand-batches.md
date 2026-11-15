# Manual first: hand batches, playbooks, then code

**Short answer**

When an automated flow keeps failing, stop the bot and do the work by hand in small batches. Each
batch writes down what worked. Only then does a worker turn those notes into code. This works for a
new site, a new form, a sign-up flow or any other new flow that agents drive in a browser.

**Where it fits**

The master session (`docs/master-session.md`) runs the batches. A batch is a background agent that
uses eyes and hands (the `eyes-hands` skill). Firstmate builds the code from the notes.

```
 find work without a browser ──► queue
                                  │
                                  ▼
       ┌──────────── hand batch: one agent, one browser, 8-12 items, time cap
       │                          │ rows + lessons
       │                          ▼
       └── next brief ◄─── playbook file ───► ledger row (tokens, minutes)
                                  │
                                  ▼
             firstmate turns playbooks into drivers ──► tests pass ──► bot back on
```

**Step by step**

1. Stop the failing bot (`hcron pause <job>`). Do not keep restarting it.
2. If you can, find the work without a browser: use a site's public application programming
   interface (API) with `curl`.
3. Start one batch. Give a background agent 8-12 items and a time cap, such as 80 minutes.
4. Tell the agent to measure the cap with `date`, not by its own estimate.
5. Run only one batch at a time. A browser can fill only one form at a time.
6. Make each batch write a playbook file. Per item, it records the steps, the fields, the control
   types, the action that worked, the failures and the screenshots. It ends with a lessons section.
7. Put the lessons of the earlier batches into the brief of the next batch.
8. Add one ledger row per batch: date, batch, done, skipped, tokens, minutes and model.
9. While a batch runs, let an agent without a browser plan the next queue.
10. Send the playbooks to firstmate. It builds or rebuilds the drivers from what worked.
11. Turn the bot back on for that flow only after the new drivers pass their tests.

**Terms**
- **Batch**: one background agent run that works through a short list of items by hand.
- **Playbook**: the file in which a batch records how it did each item and what it learned.
- **Ledger**: a table with one row per batch, used to watch the cost per item over time.
- **Driver**: the code that later does the same flow without an agent.

**Worked example**

A bot failed for a week and finished almost no items. Hand batches of 8-12 items then finished 33
items in one day. Each item took about 4 minutes and about 30,000 tokens. The playbooks then went
to firstmate as the input for new drivers. A good target for a known form is under 60 s and under
5,000 tokens per item.

**Between batches: restart the browser**

A browser grows across batches. In one case, a batch opened a new tab for each search. The browser
used about 10 gigabytes (GB) of memory, the swap reached about 34 GB, and other jobs timed out.
- Restart the batch's browser between batches. Close the batch's own tabs first.
- Check the tabs again after the restart. A browser can restore the tabs that you closed.
- Tell each batch to reuse one tab for its searches and to close each tab when an item is done.

**Codes sent by email**

Some application systems send a one-time code by email when you submit a form. A batch cannot read
that code unless the user gave it access to that mailbox.
- Ask the user before an agent reads their mail. Use a read-only mail credential.
- Match the mail by subject and site name. The sender address can change from one mail to the next.
- If nobody can read the code in time, skip that item in the batch and list it for the user.

**Warnings**
- Filling a form by hand does not take the bot's lock. Hold the driver first, or a running bot can
  clear your form.
- Do not put a short timeout on a background wait for a batch. A timeout that is too short can skip
  the whole batch.
- Do not restart a batch in the middle of a submit. Check the result of that item first.

**What to do next**

Read the newest playbooks before you change a driver. They show what a person-like run actually did.

# Thresholds and where they come from

Measured on 8 November 2026 on an Apple M1 Pro (10 cores, 32 GB). Inputs: the 2,208 production functions of
koekalenteri from the 5 November run, their CodeRankEmbed vectors from PyTorch (sentence-transformers, max
sequence length 512, normalized, first 1,500 characters of each function), and the nine replayed agent tasks of
that run. The measurement scripts ran from a scratchpad and are not in this repository.

## Runtime: ONNX against PyTorch

The model is `nomic-ai/CodeRankEmbed` at revision `3c4b608`, exported with `torch.onnx` (opset 17). Its rotary
position tables are built lazily; exported as is, the graph only accepts the input length it was traced with.
Building the tables for 2,048 positions before export fixes that (checked against PyTorch at lengths 5 to 512).
No export on Hugging Face was used: several exist from third parties, but the release asset here is built from
the official weights and pinned by sha256.

Cosine of each ONNX vector with the PyTorch vector of the same function, 200 functions:

| Variant                                 |   Size | Functions/s (CPU, 8 threads) |            Cosine min | Cosine median |
| :-------------------------------------- | -----: | ---------------------------: | --------------------: | ------------: |
| fp32 (chosen)                           | 548 MB |                         14.6 |               0.99971 |       1.00000 |
| int8, dynamic, all ops                  | 138 MB |       23.8 (transformers.js) |                 0.897 |         0.922 |
| int8, dynamic, MatMul only, per channel | 209 MB |              not timed alone |                 0.922 |         0.948 |
| fp16 weights                            | 275 MB |        3.9 (transformers.js) | not measured reliably |               |
| fp32 on the CoreML provider             | 548 MB |        3.5 (transformers.js) |                       |               |

The quantized variants move vectors by 0.05 to 0.10, as much as the gap between a copy and a different job, so
fp32 it is. Vectors are stored as float16: against float32, cosine min 0.99995.

Indexing all of koekalenteri (1,541 files, 6,075 chunks, test code and docs included) took 602 s once; the cache
is about 20 MB on disk.

## Pairing rule

Cosine at or above the threshold, each the other's nearest neighbour, neither calls the other, both at least 60
AST tokens, identical AST hashes reported apart as exact copies. Pairs after all filters, 2,208 functions:

|     Threshold | Pairs | Cross-folder | Same folder | Known true pair (statusLine) | Known false pair (wrapper) |
| ------------: | ----: | -----------: | ----------: | :--------------------------- | :------------------------- |
|          0.74 |    73 |           10 |          63 | kept                         | dropped                    |
| 0.76 (chosen) |    51 |            9 |          42 | kept                         | dropped                    |
|          0.78 |    44 |            7 |          37 | kept                         | dropped                    |
|          0.80 |    36 |            5 |          31 | kept                         | dropped                    |
|          0.84 |    23 |            4 |          19 | kept                         | dropped                    |
|          0.88 |    10 |            2 |           8 | kept                         | dropped                    |
|          0.92 |     5 |            1 |           4 | kept                         | dropped                    |

For comparison, jina-embeddings-v2-base-code at 0.84 gave 65 pairs, 7 cross-folder.

Scores of the confirmed pairs (CodeRankEmbed, jina in brackets): statusLine 0.949 (0.986), the two
getRegistrationEmails 0.845 (0.853), the two seededEdit 0.766 (0.861). The wrapper pair
registrationEmailTemplateData / getRegistrationEmailTemplateData scores 0.840 (0.888); the caller filter drops it
at every threshold. CodeRankEmbed spreads scores lower than jina, so the threshold moves down: 0.76 is the
highest value that keeps all three confirmed cross-folder pairs. On today's koekalenteri (3,582 production
functions, scripts included) `semindex pairs` reports statusLine at 0.949 and seededEdit at 0.763, and not the
wrapper pair.

## Hook thresholds: the nine agent tasks

Each row is the function an agent wrote without help, compared with the existing function it duplicated
(CodeRankEmbed, jina in brackets). "Rank" is the place of the existing function among all production functions.

| Task                            | New function                         | Existing function                 | Folder |         Score | Rank | Outcome on 5 Nov      |
| :------------------------------ | :----------------------------------- | :-------------------------------- | :----- | ------------: | ---: | :-------------------- |
| Edit-token header               | setHeaders                           | setAuthorizationHeader            | same   | 0.567 (0.733) |    1 | hook not needed       |
| Start-number publish map        | getStartNumbersPublishedClassMap     | getStartListPublishedClassMap     | same   | 0.879 (0.880) |    1 | flagged, merged       |
| same task                       | buildStartNumbersClassPublishedPatch | buildStartListClassPublishedPatch | same   | 0.911 (0.948) |    1 | flagged, merged       |
| DynamoDB REMOVE clause          | processRemove                        | processOperations                 | same   | 0.400 (0.528) |    1 | hook not needed       |
| Judge select (invalid)          | TaskScore                            | JudgeSelect                       | same   | 0.328 (0.442) |   73 | task invalid          |
| Places per day                  | distributeDayPlacesAmongClasses      | distributePlacesAmongClasses      | same   | 0.813 (0.860) |    1 | flagged, reused       |
| Participants by class           | getParticipantsByClass               | groupRegistrationsByClass         | other  | 0.671 (0.752) |    2 | missed                |
| same, with the optional command | groupParticipantsByClass             | groupRegistrationsByClass         | other  | 0.830 (0.866) |    1 |                       |
| Same entry, dates in any order  | isSameEntry                          | sortRegistrationDates             | other  | 0.338 (0.482) |   50 | hook not needed       |
| Start-number audit key          | startNumbersAuditMessageKey          | getStartNumbersAuditMessageKey    | other  | 0.895 (0.885) |    1 | flagged, copy removed |
| Owner's role                    | getOwnerRole                         | resolveOwnerSelection             | same   | 0.623 (0.702) |    2 | flagged on 5 Nov      |
| same task                       | getOwnerRole                         | ownerSelectionValue               | other  | 0.583 (0.734) |    3 |                       |

The "0.76 match that does a different job" from 5 Nov is not named in the record. The jina matches near 0.76 in
these runs that are not the duplicate are distributeDayPlacesAmongClasses vs eventClassPlaces (lambda stats,
0.762; CodeRankEmbed 0.601) and getStartNumbersPublishedClassMap vs isStartListPublishedForClass (0.756;
CodeRankEmbed 0.678). Both fall below the chosen thresholds.

The owner's-role row does not reproduce: the function the agent finally kept scores 0.70 with jina, below its
0.8 threshold, although the hook-style message flagged a match on 5 Nov. The message was probably computed on an
earlier draft of the function, which the replay does not keep.

How often a threshold fires, as a share of the 2,208 functions whose best match (leave-one-out, at least 30
tokens) passes it; a proxy for how often the hook speaks:

| Threshold | Same folder | Other folder |
| --------: | ----------: | -----------: |
|      0.60 |      55.3 % |       35.9 % |
|      0.65 |      41.1 % |       21.6 % |
|      0.70 |      28.6 % |       11.1 % |
|      0.75 |      16.8 % |        4.6 % |
|      0.80 |       8.6 % |        1.8 % |
|      0.85 |       3.8 % |        0.5 % |

Chosen:

- Same folder 0.80. The true copies scored 0.81 to 0.91 and the closest different-job match 0.68. The 0.813 copy
  sits close to the line.
- Other folder 0.75. Nine tasks are too few to place this threshold: the only other-folder copies are one at
  0.895 (caught by anything up to 0.85) and one at 0.671 (missed, as with jina). Catching the 0.671 copy needs
  0.65, which fires for one function in five. 0.75 keeps the other-folder bar softer than the same-folder one
  at a firing rate of about one in twenty, and is a value to revisit with more tasks.
- Minimum 30 AST tokens for a match by score (the pairing rule keeps 60): the audit-key copy that was caught
  has 46. A shorter function is still compared, and listed with its exact copies only.
- An identical AST hash is always listed, as an exact copy. When either function is under 30 tokens the text
  has to match as well, apart from the declared name and whitespace: at that length an identical AST hash
  joins functions that do different jobs. In six pull requests with no known copy, the AST hash alone gave six
  short functions such matches (`isMicrochip` with `isPublicRegistrationOperationField`, three page components
  that each wrap a different component in the same guard); the text rule gave none.

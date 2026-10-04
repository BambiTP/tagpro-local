# TagPro group presets

How TagPro's group presets work: the code from the group page's **Generate Preset** button, and the
`/groups/create?preset=<code>` link. tagpro-local copies this format exactly, including the real
server's bugs, in [`server/preset.js`](../server/preset.js).

Everything here was worked out in October 2026 by changing settings in live groups on
tagpro.koalabeast.com and generating and loading presets there.

## Who makes the preset

TagPro's server makes and reads presets; the group page only displays them.

- **Generate:** the page sends `groupPresetGenerate` and the server answers with `groupPreset` (the code,
  or an empty string when every setting is at its default). The "link" button wraps the code as
  `<origin>/groups/create?preset=<encodeURIComponent(code)>`.
- **Load:** the page sends `groupPresetApply` with the text from the box. The server answers with
  `groupPresetResult` (`true` or `false`); `false` shows "This is not a valid Group Preset."

## Layout

```
gZ <entry> <entry> ...
```

There is one entry for each setting that differs from its default, always in the fixed order of the
table below, whatever order the settings were changed in. If every setting is at its default, the preset
is an empty string.

Each entry is a one-letter key followed by its value:

- **On/off settings:** the key alone, meaning "the opposite of the default".
- **Numbers:** written in base 52 at a fixed width, most significant digit first, using the digits
  `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ` (a = 0, z = 25, A = 26, Z = 51).
- **Choices:** one letter.

Example: `gZtkoauHtYRf` is

| Entry | Meaning |
|---|---|
| `tk` | time 10 minutes (k = 10) |
| `o` | overtime off |
| `au` | acceleration 200% (u = 20, ÷ 10) |
| `Ht` | ghost mode: no team collisions |
| `Y` | analytics off |
| `Rf` | sticky ball fix: no handoff |

## Entries, in order

"Digits" is the fixed number of base-52 digits. "Range" is what loading accepts (see
[Loading](#loading)), which is wider than the page's dropdowns.

| Key | Setting | Value | Default (not written) | Range when loading |
|---|---|---|---|---|
| `M` | map | see [Maps](#maps) | random | |
| `g` | mode | `c` classic, `e` eggball, `i` ice hockey, `g` gravity, `r` racing | classic | |
| `t` | time (minutes) | 1 digit | 6 | 0–20 |
| `c` | caps | 1 digit | 0 | 0–51 |
| `A` | laps | 1 digit | 3 | 1–20 |
| `o` | overtime | key alone = off | on | |
| `i` | overtime respawn increment | 3 digits, ms ÷ 100 | 3000 | 0–10,000 ms |
| `J` | overtime juke juice | key alone = off | on | |
| `B` | rolling bomb behavior | key alone = classic | default | |
| `y` | mercy rule | 1 digit | 3 | 0–51 |
| `a` | acceleration | 1 digit, × 10 (1.5 → 15) | 1 | 0–3.0 |
| `e` | top speed | 1 digit, × 10 | 1 | 0–3.0 |
| `N` | bounce | 1 digit, × 10 | 1 | 0–3.0 |
| `r` | player respawn | 3 digits, ms ÷ 100 | 3000 | 0–3,600,000 ms |
| `s` | boost respawn | 3 digits, ms ÷ 100 | 10000 | 0–3,600,000 ms |
| `m` | bomb respawn | 3 digits, ms ÷ 100 | 30000 | 0–3,600,000 ms |
| `u` | powerup respawn | 3 digits, ms ÷ 100 | 60000 | 0–3,600,000 ms |
| `V` | juke juice duration | 3 digits, ms ÷ 100 | "20000" (see quirk 3) | 0–3,600,000 ms |
| `U` | rolling bomb duration | 3 digits, ms ÷ 100 | "20000" | 0–3,600,000 ms |
| `Z` | TagPro duration | 3 digits, ms ÷ 100 | "20000" | 0–3,600,000 ms |
| `O` | potato timer | 3 digits, ms ÷ 1000 | 0 | 0–180,000 ms |
| `d` | powerup delay | key alone = off | on | |
| `I` | last possession | `d` disabled, `a` always, `t` tied, `w` winnable, `o` tied or winnable | disabled | |
| `H` | ghost mode | `d` disabled, `p` no player, `t` no team, `e` no enemy, `m` no mars ball, `n` no player or mars ball | disabled | |
| `z` | pop and portal boosts | key alone = off | on | |
| `k` | kissing flag carriers | key alone = off | on | |
| `K` | kissing TagPros | key alone = off | on | |
| `S` | juke juice boost | key alone = on | off | |
| `P` | juke juice boost power | 1 digit, % ÷ 5 | 70 | 0–255 |
| `f` | rolling bomb force | 1 digit, × 10 | 1 | 0–3.0 |
| `l` | rolling bomb distance | 1 digit, × 10 | 1 | 0–3.0 |
| `D` | spacebar detonates all | key alone = on | off | |
| `X` | TagPro max tags | 1 digit | 0 | 0–51 |
| `Q` | gravity well force | 1 digit, (force + 3) × 4 (−3 → `a`, 3 → `y`) | 1 | −3 to 3 |
| `Y` | analytics | key alone = off | on | |
| `C` | disable user scripts (`noScript`) | key alone = on | off | |
| `j` | juke juice powerup | key alone = disabled | enabled | |
| `T` | TagPro powerup | key alone = disabled | enabled | |
| `b` | rolling bomb powerup | key alone = disabled | enabled | |
| `L` | eggball: losing team starts | key alone = off | on | |
| `n` | combine juke juice and rolling bomb | key alone = on | off | |
| `p` | jump limit | 1 digit (`Z` = 51 = unlimited) | 2 | 0–51 |
| `E` | speed limit | key alone = off | on | |
| `F` | landing on players resets jumps | key alone = on | off | |
| `G` | map testing mode | key alone = on | off | |
| `w` | respawn warnings | key alone = off | on | |
| `x` | powerup indicators | key alone = off | on | |
| `R` | sticky ball fix | `n` none, `e` existing contact, `f` full (no handoff) | none | |
| `W` | sticky ball timeout | 1 digit, ms ÷ 250 | 250 | 250–1000 ms |
| `q` | server | 2-letter server key (`at` Atlanta, `ny` New York, `lo` London, `c2` Chicago 2, …; the `key` field of the group's `servers` event) | none | |
| `v` | regions | one digit for the count, then one letter per region in the order chosen: `e` US East, `c` US Central, `w` US West, `u` Europe, `o` Oceanic | all five | |

### Settings never saved

Team names, starting scores, group name, private/public, discoverable, and self-assignment are never
written to a preset, and loading a preset leaves them alone.

### When generating

- **Regions are left out:**
  - if all five are selected, in any order;
  - if a server is selected, since the server overrides them.
- **Changing the mode changes the map:**
  - Eggball and ice hockey quietly switch the map to the mode's own map. The switch isn't broadcast to the
    group page, but the preset saves it. Picking a map afterwards replaces it.
  - Gravity resets the map to Random (this one is broadcast).

## Maps

`M`, then one digit for the body's length, then the body:

| Map | Body | Example |
|---|---|---|
| Fortunate Maps `fm_id/N` | `f` + N in base 52 | `fm_id/1` → `Mcfb`; `fm_id/12345` → `MefeDv` |
| Named map from the dropdown | a fixed 19-character code starting with `i` | Arti → `MtibYzdLdLVycwZWKqgtg` |
| Eggball's map | the "eggball" dropdown entry's code | `MtibZKtNKXzjbmPZyNOMg` |
| Ice hockey's map (hidden, not in the dropdown) | `iceCeJmXorbGHmpbbrX` | |
| Random CTF / Random NF | written raw with **no key**: `random_ctf`, `random_nf` | `gZrandom_ctf` (see quirk 1) |

The named-map codes aren't derived from the map name in any way that could be found, so they have to be
looked up. [`server/presetMaps.json`](../server/presetMaps.json) has all 455 maps in the dropdown as of
October 2026. A map added to TagPro later needs its code recorded the same way: select it in a group and
generate a preset.

## Loading

### The whole preset is refused

The answer is `false` and nothing changes if any of these is true:

- **The start is wrong:**
  - It doesn't start with `gZ` (this is case-sensitive).
  - It is just `gZ`.
- **A letter isn't recognised:**
  - An unknown key letter, including stray characters such as spaces inside it or `%`.
  - An unknown letter in a choice setting (mode, last possession, ghost mode, sticky ball fix).
- **Map problems:**
  - An unknown named-map code.
  - A Fortunate Maps ID of 0.
  - A map entry that is cut short.
- **Other cut-short entries:**
  - A server entry with fewer than 2 characters.
  - A regions entry with fewer letters than its count says.
- **It contains `random_ctf` or `random_nf`.**

**Input handling:**

- Leading and trailing whitespace is trimmed.
- A full `.../groups/create?preset=<code>` link works (TagPro uses whatever follows `preset=`).
- A link that is itself percent-encoded doesn't work.

### When a preset is accepted

1. **Every setting a preset can hold is affected.**
   - A setting the preset lists takes that value.
   - A setting it doesn't list goes back to its default, but only if its current value differs, by a
     loose (`!=`) comparison.
2. **A number outside its range is skipped.** The preset still loads, but that one setting keeps its
   current value.
3. **Cut-short and repeated entries:**
   - A number cut short by the end of the string uses whatever digits are there (`gZt` = 0 minutes).
   - If a key appears twice, the last one wins (`gZtktb` = 1 minute).
   - An on/off key repeated is still just "on" (`gZoo` is the same as `gZo`).
4. **Server:**
   - A known server key turns on "select server", picks that server, and clears the regions.
   - An unknown 2-letter key is ignored.
5. **Regions:**
   - A bare `v` with no count means no regions.
   - An unknown region letter is accepted, but the regions are left as they were.
   - Duplicate regions and any order are kept as written.
6. **Mode and map:**
   - The mode is applied after the map, so a preset with eggball or ice hockey always ends up on that
     mode's own map, even if it named a different one.
   - Gravity keeps the preset's map when loaded.

## TagPro quirks

tagpro-local keeps all of these on purpose, so presets behave the same on both.

1. **Random CTF / Random NF can't be loaded.** Presets using them are generated, but loading one is
   always refused.
2. **Eggball and ice hockey lose a chosen map.** With either mode, a map picked in the group is replaced
   by the mode's map when the preset loads.
3. **The powerup durations stick as numbers.**
   - A new group's three powerup durations default to the *string* `"20000"`. Changing one stores a
     *number*, and the server compares strictly when writing presets.
   - So setting 20 seconds by hand still writes `VadS` / `UadS` / `ZadS`.
   - Once changed, loading any preset resets the duration to the *number* 20000 (the loose reset in
     rule 1), so it then appears in every later preset from that group.
4. **Loading accepts values the page never offers,** such as acceleration 0, caps 51, boost power 255,
   and a 180-second potato timer.

## In tagpro-local

- [`server/preset.js`](../server/preset.js):
  - `encode(settings, modeMap)` makes a preset.
  - `parse(text)` reads one, or returns `null` where TagPro would refuse it.
  - `apply(settings, parsed)` loads it with the rules above.
- [`server/presetMaps.json`](../server/presetMaps.json): map name → preset code.
- [`server/groups.js`](../server/groups.js):
  - Handles `groupPresetGenerate` and `groupPresetApply`, and the `preset` field of group creation.
  - Keeps the hidden eggball / ice hockey map in `group.modeMap`.
  - Resets the map to Random when gravity is picked.
  - Stores the powerup durations as numbers once a leader sets them.

### Not covered

- **Uploaded maps:** never tested, so they aren't written to presets.
- **Eggball and ice hockey games in tagpro-local:** these still start on the selected map, not the mode's
  own map.
- **The real server's `selectMaps` setting:** this hides the map dropdown in eggball and ice hockey.
  tagpro-local doesn't have it.

### How it was checked

Every result below was recorded from tagpro.koalabeast.com, and tagpro-local's code matches all of them:

- **Generating:** 153 fresh groups with random mixes of settings, maps, regions and servers, plus every
  value of every setting on its own.
- **Loading:** 1,102 checks of which presets are refused, which settings change, and the preset
  regenerated afterwards. These include about 90 hand-made edge cases and back-to-back loads in the same
  group.
- **Ranges:** 437 probes of which values are accepted.

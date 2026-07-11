# CloneCraft Bedrock Add-on Specification

## 1. Document status

- **Project:** CloneCraft
- **Document type:** implementation specification
- **Target platform:** Minecraft Bedrock Edition behavior pack
- **Script API target:** `@minecraft/server` `2.9.0-beta` (the repository currently installs `2.9.0-beta.1.26.33-stable`)
- **Language:** TypeScript, bundled to JavaScript
- **Initial release:** core shared-state multiplayer behavior

This specification defines the first production-capable version of CloneCraft. It is intentionally explicit about Script API limits. Where Bedrock does not expose an atomic or cancellable event, the design uses observation, deterministic reconciliation, and repair on the following tick.

## 2. Product definition

CloneCraft makes every active Survival or Adventure player a clone of one logical character. Players remain separate entities with independent positions, dimensions, camera state, status effects, and world interactions, but the enabled gameplay resources are shared.

The logical character owns:

- current health;
- absorption, when the installed API exposes a reliable readable and writable value;
- hunger;
- saturation;
- the 36-slot player inventory;
- head, chest, legs, and feet equipment;
- offhand equipment;
- total experience;
- selected hotbar slot;
- the pool-wide alive, dying, respawning, or recovery state.

The shared state is authoritative. No individual player is permanently designated as the owner or leader.

## 3. Goals

The first release shall:

1. Admit joining players into one active pool and overwrite their local shared resources with the pool state.
2. Keep health, hunger, saturation, inventory, equipment, offhand, experience, and selected slot synchronized.
3. Count legitimate concurrent resource consumption once per player action when it can be inferred safely.
4. Prevent script-generated replication changes from being interpreted as new player actions.
5. Make one clone's death a pool-wide death.
6. Preserve the authoritative state when the last player disconnects and restore it later.
7. Provide diagnostics and recovery controls.
8. Fail closed on ambiguous inventory conflicts: preserve a consistent state and report the conflict rather than create items.

## 4. Non-goals for version 1

The following are not shared unless added in a later milestone:

- position, velocity, rotation, dimension, spawn point, or camera;
- potion/status effects;
- air supply, fire duration, freezing, or fall distance;
- ender chest contents;
- achievements, advancements, recipes, or statistics;
- attack cooldowns and item cooldown categories;
- entity targets, damage direction UI, or knockback;
- creative-mode inventory semantics;
- items inside arbitrary external containers while their UI is open.

`sharedDimension` is therefore not part of the version 1 authority. It may exist later as an optional teleportation feature.

## 5. Supported play assumptions

The supported baseline is a dedicated or locally hosted Bedrock world with the behavior pack enabled and Script API experiments required by the beta dependency enabled.

- Survival and Adventure players participate.
- Spectators are not state mutation sources. They may be excluded from the pool by configuration.
- Creative players are excluded by default because infinite placement and inventory acquisition do not map cleanly to a finite shared inventory.
- At least two players are expected, but one-player operation must remain valid.
- The implementation must tolerate players being in different dimensions.
- Script callbacks run on the game thread; “simultaneous” means observations collected within the same reconciliation window, normally one server tick.

## 6. Script API capability map

The implementation shall use the installed typings as the compile-time source of truth.

| Concern | Script API mechanism | Design consequence |
|---|---|---|
| active players | `world.getAllPlayers()` / `world.getPlayers()` | rebuild the live player map when necessary |
| join readiness | `world.afterEvents.playerJoin` and `playerSpawn` | join identifies a player; initial spawn is the first safe point to apply components |
| leave | `world.beforeEvents.playerLeave` plus `afterEvents.playerLeave` | capture a final readable snapshot before invalidation; then remove membership |
| health | `minecraft:health` component and `entityHealthChanged` | observe changes and use `setCurrentValue` during replication |
| hunger | `minecraft:player.hunger` attribute component | read and use `setCurrentValue`; polling is still required |
| saturation | `minecraft:player.saturation` attribute component | read and use `setCurrentValue`; polling is required |
| inventory | `minecraft:inventory` component, `Container`, and `playerInventoryItemChange` | event is observational and after-the-fact; reconciliation repairs replicas |
| equipment | `minecraft:equippable`, `EquipmentSlot`, `getEquipment`, `setEquipment` | armor and offhand are separate from the 36 inventory slots |
| selected slot | `Player.selectedSlotIndex` and `playerHotbarSelectedSlotChange` | direct read/write and event-driven observation |
| XP | `getTotalXp`, `resetLevel`, `addExperience` | replicate by reset then add authoritative total; poll for changes |
| death | `entityDie`, `Player.kill()`, and `playerSpawn` | explicit death state machine is required |
| keep inventory | `world.gameRules.keepInventory` | sample at death transition and apply the matching policy |
| persistence | world dynamic properties | JSON must be chunked/versioned and written only at checkpoints |
| admin events | `system.afterEvents.scriptEventReceive` | `/scriptevent clonecraft:<command> ...` is the supported command surface |

Important API limitations:

- Inventory change events are after-events. They cannot provide a general atomic, cancellable inventory transaction.
- Hunger and saturation do not provide complete high-level “player ate” or “exhaustion changed” events; attribute polling is required.
- Total XP has readable and additive/reset APIs but no comprehensive XP-changed event; polling is required.
- A manually serialized item cannot be guaranteed to preserve every vanilla or custom component. Live state must retain cloned `ItemStack` values whenever possible.
- Dynamic properties accept primitive values and vectors, not `ItemStack`. Persistent item restoration is necessarily a supported-field reconstruction unless a future API exposes native item serialization.
- Absorption support must be feature-detected. If no stable writable component exists in the installed version, version 1 reports it as unsupported rather than simulating yellow hearts incorrectly.

## 7. Configuration

`src/config.ts` shall export immutable defaults and a validated runtime configuration.

```ts
interface CloneCraftConfig {
  enabled: boolean;
  shareHealth: boolean;
  shareHunger: boolean;
  shareInventory: boolean;
  shareEquipment: boolean;
  shareExperience: boolean;
  shareSelectedSlot: boolean;
  shareDeath: boolean;
  allowLateJoining: boolean;
  saveStateBetweenSessions: boolean;
  reconciliationIntervalTicks: number;
  persistenceIntervalTicks: number;
  joinApplyDelayTicks: number;
  respawnGraceTicks: number;
  applyLockTicks: number;
  conflictMode: "deterministic";
  excludeCreative: boolean;
  excludeSpectator: boolean;
  diagnosticsLevel: "off" | "errors" | "verbose";
  logLevel: "error" | "warn" | "info" | "debug";
}
```

Defaults:

| Setting | Default | Requirement |
|---|---:|---|
| enabled | true | Master switch |
| all core `share*` flags | true | Except unsupported absorption |
| allowLateJoining | true | Reject pending player when false |
| saveStateBetweenSessions | true | Save on commits and empty transition |
| reconciliationIntervalTicks | 1 | Required for food, XP, and missed inventory events |
| persistenceIntervalTicks | 100 | Dirty-state checkpoint every five seconds |
| joinApplyDelayTicks | 1 | Wait for components/containers after initial spawn |
| respawnGraceTicks | 10 | Prevent death/reapply loops |
| applyLockTicks | 2 | Covers mutation event delivery |
| conflictMode | deterministic | Only supported mode in v1 |

Values must be validated at startup. Tick intervals must be positive integers and apply-lock duration must be at least one tick.

## 8. Architecture and modules

```text
src/
  main.ts
  config.ts
  model/
    types.ts
    sharedState.ts
  pool/
    playerPool.ts
    persistence.ts
  sync/
    coordinator.ts
    healthSync.ts
    hungerSync.ts
    inventorySync.ts
    equipmentSync.ts
    experienceSync.ts
    selectedSlotSync.ts
    deathSync.ts
  inventory/
    itemCodec.ts
    snapshot.ts
    comparator.ts
    transactionQueue.ts
    resolver.ts
  admin/
    scriptEvents.ts
    diagnostics.ts
  utilities/
    applyLock.ts
    guards.ts
    logging.ts
    ids.ts
```

`main.ts` performs composition only: load configuration, construct the state store and coordinator, subscribe events once, start intervals, and expose no game rules of its own.

The coordinator is the sole writer to `SharedState`. Sync modules translate API events/observations into intents and know how to apply one subsystem to a player. They do not commit independently.

## 9. Shared data model

```ts
type PlayerKey = string; // Player.id during a live session

interface SharedState {
  schemaVersion: 1;
  initialized: boolean;
  epoch: number;
  dirty: boolean;
  enabled: boolean;
  health: number;
  hunger: number;
  saturation: number;
  inventory: ReadonlyArray<ItemStack | undefined>; // exactly 36
  equipment: Readonly<Record<EquipmentKey, ItemStack | undefined>>;
  totalXp: number;
  selectedSlot: number; // 0..8
  death: SharedDeathState;
  lastCommitTick: number;
}

type EquipmentKey = "head" | "chest" | "legs" | "feet" | "offhand";

interface SharedDeathState {
  phase: "alive" | "killing" | "waiting_for_respawns" | "restoring";
  generation: number;
  expectedPlayerIds: string[];
  respawnedPlayerIds: string[];
  startedTick?: number;
  keepInventoryAtDeath?: boolean;
}
```

The in-memory store uses `ItemStack.clone()` on capture, comparison boundaries, and replication. It never holds a reference assumed to remain attached to a container.

Per-player runtime metadata is not persisted:

```ts
interface PlayerRuntime {
  id: PlayerKey;
  phase: "pending_spawn" | "applying" | "active" | "dead";
  lastObservation?: PlayerObservation;
  appliedEpoch: number;
  lockUntilTick: number;
  joinedTick: number;
  lastSeenTick: number;
}
```

## 10. Initialization and pool lifecycle

### 9.1 Startup

1. Subscribe all event handlers before reading players.
2. Load and validate persisted metadata and chunks.
3. Enumerate `world.getAllPlayers()` and place valid players in `pending_spawn` or schedule admission if already spawned.
4. Start the one-tick coordinator interval and persistence checkpoint interval.

### 9.2 First-ever initialization

If no valid saved state exists and the pool is empty, the store remains uninitialized.

When the first eligible player spawns:

1. wait `joinApplyDelayTicks`;
2. read a complete observation;
3. validate required components and inventory size;
4. initialize all shared fields from that player;
5. set `initialized = true`, increment epoch, save immediately;
6. admit any other pending players by replacing their replicas with this state.

If multiple players become ready in the same tick, choose the source by ascending stable key (`Player.id`, then name only for logging). This choice must not depend on callback order.

### 9.3 Join

`playerJoin` records a pending member only. `playerSpawn` with `initialSpawn === true` schedules actual admission.

If shared state already exists:

- do not inspect the joiner's inventory as an intent;
- acquire their apply lock;
- replace every enabled subsystem with the shared state;
- verify on the next reconciliation tick;
- mark active only after successful verification;
- if verification fails, retry up to three times, then exclude the player and emit an error.

When `allowLateJoining` is false and another active player exists, the joiner is not admitted. Version 1 sends an explanatory message but does not kick them.

### 9.4 Leave

`playerLeave` removes runtime metadata and pending intents from that player. The shared state is not recalculated from the leaving player's now-inaccessible entity.

If a player leaves after producing observed changes but before commit, already-captured valid intents remain eligible for that tick. If their change was never observed, it cannot be recovered.

When the pool becomes empty, flush dirty state immediately. Intervals may continue at low cost, but no reconciliation is attempted.

### 9.5 Identity

Use `Player.id` only as a session membership key. Do not persist ownership keyed solely by entity ID. Player names are display strings and are not identity keys.

## 11. Tick and commit model

The coordinator owns a six-stage tick pipeline:

1. **Drain events**: collect all event hints received since the previous boundary.
2. **Observe**: snapshot every unlocked active replica in stable player-ID order.
3. **Infer**: compare each observation with its last observation and with the current shared state; create normalized intents.
4. **Resolve**: validate, sort, and apply intents to a working copy of shared state.
5. **Commit**: if the working copy changed, replace state once, increment epoch once, and mark dirty.
6. **Replicate and verify**: apply the committed state to all active players under locks; verify after locks expire.

No event callback directly rewrites all players. It adds a hint or schedules special handling. This prevents callback order from becoming the conflict policy.

Stable intent ordering:

1. death;
2. health loss;
3. health gain;
4. food/saturation consumption result;
5. inventory item consumption;
6. durability increase (tool wear);
7. item removal/drop/place;
8. item addition/pickup/craft;
9. slot movement/equipment movement;
10. experience delta;
11. selected-slot change.

Within a category sort by source tick, source player ID, affected location, item type ID, then a locally assigned sequence number. The sequence number breaks otherwise identical ties but must not supersede the earlier stable fields.

## 12. Apply locks and feedback prevention

An apply lock is per player, not global. A global boolean would discard a real action by player B while player A is being updated.

Before mutating a replica:

1. set `phase = applying`;
2. set `lockUntilTick = currentTick + applyLockTicks`;
3. set `appliedEpoch` to the epoch being applied;
4. perform all writes in one scheduled callback;
5. capture an expected post-apply fingerprint.

Events from a locked player are retained only as hints tagged `replication_candidate`; they are discarded if they match the expected fingerprint. An unexpected difference must be reconciled after unlock, not silently ignored.

Locks expire by tick number even if an exception occurs. Every apply function uses `try/finally` to leave recoverable runtime state.

## 13. Health synchronization

### 12.1 Observation and intent

Subscribe to `entityHealthChanged`, filtered in code to active player entities. The event is a wake-up/hint; the health component is read at the tick boundary.

For an unlocked active player:

```text
delta = observedHealth - lastObservedHealth
```

- `delta < 0` creates a health-loss intent with magnitude `abs(delta)`;
- `delta > 0` creates a health-gain intent;
- no intent is created when observation matches the epoch CloneCraft just applied.

Health intents are deltas against the shared value, not absolute winner-takes-all assignments. Therefore, two players each taking 3 damage in the same tick cause 6 shared damage. Clamp the result to the common valid range supported by all active health components.

The default policy shares final health loss, including damage already reduced by armor, resistance, and local absorption. Because clones can have different local effects, this may produce different event-side calculations; the observed post-mitigation health delta is authoritative.

### 12.2 Replication

Use `EntityHealthComponent.setCurrentValue(sharedHealth)` under the apply lock. Never call damage APIs merely to reproduce UI animation because that can re-run armor, effects, thorns, and death logic.

### 12.3 Zero and death

If a resolved health commit is `<= 0`, do not attempt to set zero on each player as the only death mechanism. Enter the death state machine and call `player.kill()` once per alive active player under death-generation protection.

An independently observed `entityDie` for any active player also starts shared death, even if a preceding zero-health observation was missed.

### 12.4 Healing conflicts

Damage is resolved before healing in the same tick. If damage reaches zero, death wins and later healing intents in that tick are discarded. Otherwise healing is applied and clamped.

## 14. Hunger and saturation synchronization

There is no comprehensive food-level event, so each reconciliation tick reads:

- `minecraft:player.hunger`;
- `minecraft:player.saturation`.

`itemCompleteUse` and `itemUse` are hints that help classify food consumption but are not treated as authoritative values.

For each unlocked player, infer deltas from the previous observation. Resolution applies hunger and saturation deltas to the shared values in stable order and clamps to the intersection of active component bounds.

This shares all changes visible through the attributes, including sprint/jump exhaustion outcomes, regeneration costs, eating, starvation, and effects. Exhaustion itself is not shared in version 1. Because local exhaustion can later cause repeated divergent food changes, every replication also normalizes the hunger and saturation attributes; an optional future release may share `minecraft:player.exhaustion` explicitly.

Apply using each component's `setCurrentValue()`. If hunger application succeeds and saturation application fails, log the partial failure and retry the complete pair next tick. The shared state remains authoritative.

When two players eat simultaneously, both positive deltas are accepted and clamped. Each corresponding item consumption is independently resolved by inventory logic.

## 15. Inventory and equipment model

### 14.1 Logical locations

Inventory locations are `inventory:0` through `inventory:35`. Equipment locations are `equipment:head`, `chest`, `legs`, `feet`, and `offhand`.

Armor/offhand are excluded from the 36-slot inventory snapshot and handled through `EntityEquippableComponent`. Cursor inventory, crafting grid, ender chest, and open container contents are not shared.

### 14.2 Item fidelity in memory

Capture an item using `stack.clone()`. Comparison uses a canonical fingerprint containing all accessible state:

- type ID and amount;
- name tag and lore;
- durability damage and unbreakable flag;
- enchantment type IDs and levels, sorted by ID;
- item dynamic properties, sorted by key, when supported;
- `keepOnDeath` and `lockMode`;
- `getCanDestroy()` and `getCanPlaceOn()` lists;
- other explicitly supported mutable component fields added by tests.

Comparison has two forms:

- **identity fingerprint** excludes amount and durability damage, used to recognize the same stack kind;
- **exact fingerprint** includes all accessible fields, used for replica verification.

Do not use `typeId + amount` as equality. That would lose enchantments, names, lore, and custom data.

### 14.3 Event capture

Subscribe to `playerInventoryItemChange`. Record its `inventoryType`, slot, cloned `beforeItemStack`, cloned `itemStack`, tick, and player ID. Equipment changes may not be completely represented by this event, so equipment is polled each tick as well.

Also collect hints from:

- `entityItemPickup` and `entityItemDrop`;
- `playerPlaceBlock`;
- `playerBreakBlock`;
- `itemUse`, `itemCompleteUse`, and charge-use events;
- player interaction events where useful.

Hints classify an already-observed change. They do not independently remove or create items unless the corresponding replica delta validates it.

### 14.4 Change inference

For each player, compare the previous and current full inventory/equipment snapshot. Convert changes into a multiset delta by identity fingerprint, then retain slot-level information.

Recognized operations:

- amount decrease of same identity: removal/consumption count;
- amount increase of same identity: addition count;
- same identity and amount with greater durability damage: durability use;
- exact stack moving between locations with net-zero multiset delta: movement;
- equipment-to-inventory net-zero transfer: equip/unequip movement;
- identity replacement: one removal plus one addition unless a known transform validates it.

All counts must be non-negative integers and all constructed stacks must respect `maxAmount`.

### 14.5 Validating against shared state

A removal is valid only if the shared multiset has a compatible item in the claimed source location or, for location-agnostic operations, enough compatible items in deterministic slot order.

An addition is valid only when supported by the observed replica transition. Pickup/break/craft hints increase confidence but do not bypass item validity checks.

Durability use is valid only when identity matches, the item has a durability component, and damage increased. Durability decreases are rejected unless accompanied by a recognized repair/anvil transition; unrecognized decreases trigger corrective resync.

A movement is valid only if the source and destination contents match the inferred transfer and it produces no unexplained multiset creation.

### 14.6 Conflict rules

Operations apply to a working inventory in the global order from section 11.

- Two valid removals of one block each remove two blocks if two exist.
- If only one exists, the first stable operation commits and the other is rejected; the rejected player's world action cannot always be undone. Emit a conflict warning and resync.
- Two pickups of distinct item entities add both observed quantities.
- Two moves targeting the same slot resolve by stable player ID; the losing move is rejected and resynced.
- Consumption and durability wear precede ordinary movement so a player cannot move an item to evade a simultaneous cost.
- Removal searches start at the claimed slot, then selected hotbar slot, then ascending inventory slots. This rule is deterministic and preserves intent where possible.

### 14.7 Replication

For every active player under lock:

1. acquire inventory and equippable components;
2. write all 36 inventory slots using cloned stacks or `undefined`;
3. write head, chest, legs, feet, and offhand using cloned stacks;
4. read back a fingerprint on the verification tick;
5. retry a mismatch up to three times.

Writes always cover the entire shared inventory after a commit. Partial slot replication is an optional later optimization only after epoch verification exists.

### 14.8 World-side consequences

The Script API observes many actions after the world has changed. Inventory reconciliation cannot always reverse a block already placed, projectile already fired, item entity already dropped, or crafting output already produced. Version 1 guarantees shared resource accounting and replica convergence, not rollback of an already-completed world action when a conflict is rejected.

This limitation must appear in user documentation and stress-test reports.

## 16. Item interaction requirements

| Action | Shared-state result | Local/world result |
|---|---|---|
| One block placed | Remove one compatible block | Placement remains |
| Two simultaneous placements | Remove two if available | Both placements may remain even if second cost conflicts |
| Bow/crossbow fired | Apply observed arrow/remunition removal and durability delta once | Projectile/effects remain local to shooter |
| Food eaten | Apply observed food removal, hunger, and saturation deltas | Other use effects are not copied |
| Potion drunk | Remove one potion and accept resulting bottle addition | Potion effect stays on user in v1 |
| Item dropped | Remove once from shared inventory | Spawned item entity remains and may be picked up normally |
| Item picked up | Add observed quantity once | All replicas receive it |
| Tool used | Apply observed durability increase | Break tool for all when vanilla replica transition removes it |
| Item crafted | Apply observed ingredient removals and output additions | Recipe side effects remain with crafter |
| Armor equipped | Move shared item between logical locations | All replicas wear the result |

## 17. Selected hotbar slot

Subscribe to `playerHotbarSelectedSlotChange` and also compare `Player.selectedSlotIndex` each tick.

Changes are absolute intents. If multiple players select different slots during one tick, the stable last intent in deterministic order wins. Apply `sharedSelectedSlot` to all players under per-player locks. Values outside 0 through 8 are rejected.

Because this system can make ordinary multiplayer control frustrating, it has an independent configuration flag even though it defaults on per the concept.

## 18. Experience synchronization

Poll `Player.getTotalXp()` each tick. Derive signed deltas from the last unlocked observation and apply them in stable player order. Multiple XP pickups add; multiple enchantment costs subtract.

To apply a total:

1. call `player.resetLevel()`;
2. call `player.addExperience(sharedTotalXp)` if nonzero;
3. verify `getTotalXp()` on the next tick.

Store total XP as the authority rather than independently storing level and progress. `Player.level` and progress are derived by the game, avoiding internally inconsistent state.

Negative shared total XP is forbidden. If simultaneous costs exceed available XP, accept operations until the deterministic working total would become negative, reject the remainder, warn, and resync. The already-completed enchant/anvil world-side result may not be reversible.

## 19. Death and respawn state machine

### 18.1 Starting shared death

On the first active-player death or resolved health at zero:

1. if phase is not `alive`, ignore the duplicate signal;
2. increment `generation`;
3. snapshot active player IDs into `expectedPlayerIds`;
4. read `world.gameRules.keepInventory`;
5. set phase to `killing` and shared health to zero;
6. acquire death/apply locks;
7. call `kill()` on each still-valid, living expected player;
8. move to `waiting_for_respawns`.

The generation token prevents death events produced by step 7 from starting another cycle.

### 18.2 Inventory policy

If keep inventory is true, preserve the pre-death shared inventory/equipment.

If keep inventory is false, clear shared inventory and equipment once at death commit. Vanilla death drops created by each clone can duplicate the same shared items. Therefore version 1 must actively prevent clone-multiplied drops. The implementation must choose and test one of these policies before the death feature is considered complete:

- temporarily clear non-triggering replicas immediately before killing them, allowing only one designated death body to produce drops; or
- capture and remove duplicate item entities using a generation tag and controlled drop spawning.

The first policy is the version 1 recommendation because it uses ordinary container writes. The originally dying player may already have dropped items before its event is observed; designate that player as the single drop source. If the source cannot be identified or drops cannot be bounded safely, log a high-severity diagnostic and do not spawn replacement drops.

### 18.3 Respawn barrier

`playerSpawn` with `initialSpawn === false` marks that expected player respawned. A player who leaves is removed from the expected set. A new joiner during death waits behind the same barrier.

When every remaining expected player has respawned:

1. phase becomes `restoring`;
2. wait `respawnGraceTicks`;
3. restore inventory/equipment according to keep-inventory policy;
4. restore hunger, saturation, XP, and selected slot;
5. set shared health to the minimum valid respawn health observed across players, or a configured/tested default if observation is unavailable;
6. apply that health to all;
7. clear death locks and set phase to `alive`.

If a respawn never arrives, the barrier continues for connected expected players. Administration can use `clonecraft:resync` or `clonecraft:reset` to recover.

## 20. Persistence

### 19.1 Keys

Use namespaced world dynamic properties:

```text
clonecraft:schema_version
clonecraft:meta
clonecraft:state_chunk_0
clonecraft:state_chunk_1
...
clonecraft:state_checksum
```

`meta` includes chunk count, epoch, saved tick/time where available, enabled flag, and codec version.

### 19.2 Persisted item representation

```ts
interface PersistedItem {
  typeId: string;
  amount: number;
  nameTag?: string;
  lore: string[];
  durability?: { damage: number; unbreakable: boolean };
  enchantments?: Array<{ typeId: string; level: number }>;
  dynamicProperties?: Record<string, boolean | number | string | Vector3>;
  keepOnDeath?: boolean;
  lockMode?: string;
  canDestroy?: string[];
  canPlaceOn?: string[];
  fidelity: "complete_for_known_fields" | "unsupported_metadata";
}
```

The codec reconstructs an `ItemStack`, applies known mutable fields, and verifies its fingerprint. If a live item exposes data the codec cannot recreate, mark it unsupported and emit a warning. Configuration for the first release should refuse to overwrite the last good persistent snapshot with known-lossy data unless an administrator explicitly uses `clonecraft:save force` in a future command extension.

### 19.3 Atomicity

Dynamic property writes are not treated as a multi-key transaction. Save chunks first under a new generation, then write checksum, and write `meta` last. Load only the generation referenced by valid metadata whose chunk count and checksum match.

Keep the previous generation until the new metadata commit succeeds when property limits allow it. Invalid/corrupt data is quarantined logically, logged, and never partially loaded.

### 19.4 Save triggers

- immediately after first initialization;
- when the pool transitions to empty;
- after reset;
- on explicit save;
- every `persistenceIntervalTicks` while dirty.

Saving every inventory event is prohibited because it adds needless serialization work during busy ticks.

## 21. Administration

Administration uses `/scriptevent clonecraft:<command> [arguments]`, observed through `system.afterEvents.scriptEventReceive`.

Only accept player-originated commands from operators when the API exposes a reliable permission check. Server/block-origin events may be allowed by configuration. Every rejected command returns a reason to its source when possible.

| Script event | Behavior |
|---|---|
| `clonecraft:enable` | Enable coordination; initialize from saved state or deterministic first player |
| `clonecraft:disable` | Flush state, stop accepting intents, leave current replicas unchanged |
| `clonecraft:reset` | Replace shared state from a deterministic active player after explicit confirmation mechanism is implemented |
| `clonecraft:resync` | Reapply the current epoch to every active player |
| `clonecraft:status` | Report enabled state, epoch, pool size, phase, dirty flag, lock count, and recent conflicts |
| `clonecraft:set_health <number>` | Clamp and commit shared health; zero enters death flow |
| `clonecraft:save` | Force a persistence attempt and report success/failure |

`reset` is destructive and must not be silently invoked with no source player. If there are no active players, it clears persisted state only when an explicit future confirmation syntax is supplied; otherwise it rejects.

## 22. Diagnostics and fault handling

Every log record should include severity, tick, epoch, subsystem, event code, and relevant player IDs. Avoid logging full item lore or dynamic property values at normal levels because custom data may be large or sensitive.

Required counters:

- admitted, pending, and excluded players;
- commits by subsystem;
- replication retries and failures;
- discarded feedback events;
- rejected intents by reason;
- inventory conflicts;
- persistence successes/failures and byte counts;
- death generation and phase duration;
- reconciliation duration and number of stacks compared.

Component access and entity validity can fail at any time due to disconnects. Catch failures at player boundaries so one invalid player does not stop the entire tick. A subsystem apply failure leaves the shared state unchanged, marks that replica stale, and schedules a retry. Three consecutive failures exclude that player from producing intents until a successful resync.

## 23. Performance requirements

- Perform at most one complete observation per active player per reconciliation tick.
- Cache canonical item fingerprints for the duration of a tick; do not repeatedly serialize the same stack.
- Do not write a replica whose verified epoch and exact fingerprint already match the authority.
- Spread join/recovery retries across ticks rather than creating unbounded same-tick work.
- Do not retain `Player` objects in persisted or long-lived historical records; retain IDs and reacquire live entities.
- Cap diagnostic history to a fixed ring buffer.

The initial test target is eight active players with full inventories. On the target host, the average coordinator cost must stay below one game tick and no reconciliation callback may deliberately perform blocking I/O. A stricter millisecond budget should be set after profiling on the intended Bedrock host hardware.

## 24. Security and validation

- Treat script-event arguments and persisted JSON as untrusted input.
- Bound command argument length, chunk count, JSON length, lore length, item amount, slot index, XP, and scalar attributes before use.
- Only construct item type IDs accepted by `ItemStack`; catch construction and component errors.
- Never evaluate persisted strings as code or commands.
- Do not allow a non-operator player to reset, save, enable, disable, resync, or set health.
- Redact dynamic-property values from ordinary logs.
- Use a schema version and reject unsupported future versions rather than guessing.

## 25. Test plan

### 25.1 Unit tests

Pure modules must be testable without a running world:

- exact and identity item fingerprint ordering;
- multiset and slot diff inference;
- deterministic transaction sorting;
- simultaneous removal with sufficient and insufficient quantities;
- durability wear versus repair detection;
- equipment movement;
- health/hunger/saturation/XP delta resolution and clamping;
- persistence chunking, checksum validation, migration rejection, and corrupt input;
- death-state transitions and duplicate-event suppression.

Script API objects should be isolated behind small adapters so tests can use fakes.

### 25.2 In-world integration matrix

Run each scenario with two players, then repeat concurrency cases with four or more:

1. First player initializes an empty world; second player's old inventory is overwritten.
2. Join, disconnect, reconnect, final-player leave, and world restart.
3. Damage from melee, projectile, fall, fire, drowning, poison-like effects, healing, regeneration, and starvation.
4. Simultaneous damage on two clones and damage plus healing in one tick.
5. Sprinting, jumping, eating multiple food types, and simultaneous eating.
6. Pick up, drop, place, break, consume, craft, split stacks, merge stacks, swap slots, and shift equipment.
7. Fire bows/crossbows, damage tools, break a tool, use buckets, drink potions, and use named/enchanted items.
8. Two players consume the last shared item simultaneously.
9. XP orbs, commands granting XP, enchanting costs, and simultaneous XP changes.
10. Selected slot changes by multiple players in one tick.
11. Death with keep-inventory on, death policy with it off, simultaneous deaths, disconnect during death, and delayed respawn.
12. Admin disable/enable, forced resync, invalid arguments, and unauthorized use.
13. Custom items with lore, enchantments, durability, and dynamic properties.
14. Eight-player full-inventory stress run for at least 30 minutes.

Every inventory test records the shared multiset before and after. The expected equation is:

```text
after = before + validated additions - validated removals
```

Replica equality alone is not sufficient: every replica could converge on an incorrectly duplicated result.

## 26. Delivery order

### Milestone 1: foundation

- data model, player pool, component guards, coordinator, per-player apply locks, logging;
- deterministic first-player initialization and late join overwrite;
- status and resync diagnostics.

### Milestone 2: scalar state

- health deltas and feedback protection;
- hunger and saturation polling;
- selected hotbar slot;
- XP delta synchronization;
- focused multiplayer tests.

### Milestone 3: inventory baseline

- live `ItemStack` snapshots and fingerprints;
- whole-inventory/equipment replication;
- inventory event capture and single-player-at-a-time change inference;
- fidelity tests for item metadata.

### Milestone 4: concurrent transactions

- transaction queue, classification hints, deterministic resolver;
- simultaneous placement, consumption, pickup, movement, and durability tests;
- conflict diagnostics and recovery.

### Milestone 5: death and persistence

- death/respawn state machine and keep-inventory policy;
- versioned item codec, chunked dynamic properties, atomic-generation saves;
- restart and corruption recovery tests.

### Milestone 6: administration and hardening

- complete script-event surface and authorization;
- performance profiling, retry/exclusion policy, stress testing;
- player-facing limitations and operator documentation.

## 27. Acceptance criteria

CloneCraft version 1 is complete only when:

1. A late joiner cannot import or duplicate their previous inventory.
2. Two independent health losses in one tick both affect the shared health exactly once.
3. Script-applied health, hunger, inventory, equipment, XP, and slot changes do not feed back as new intents.
4. All active replicas converge to the same exact accessible item fingerprints after each committed epoch.
5. Simultaneous valid removals consume the correct total, and insufficient-resource conflicts never create items.
6. One active-player death starts exactly one shared death generation.
7. Respawn restoration does not loop or admit mutations prematurely.
8. Empty-pool persistence survives world restart for every documented supported item field.
9. Corrupt persistence never partially overwrites a live or last-known-good state.
10. Unsupported item data and absorption capability are reported rather than silently claimed as supported.
11. Administrative commands are authorization-checked and covered by integration tests.
12. No known automated or stress test produces duplicated shared inventory.

## 28. Decisions required before implementation of the death milestone

The following product choices must be confirmed before that milestone is considered final:

1. Whether version 1 may require the world gamerule `keepInventory=true` whenever shared inventory and shared death are enabled. This specification recommends yes.
2. Whether Creative and Spectator players are excluded or synchronized read-only. This specification recommends exclusion.
3. Whether potion/status effects caused by consumed items remain local. This specification recommends local effects for version 1.
4. The intended maximum active player count, used to set performance acceptance thresholds.

These decisions do not block foundation, scalar synchronization, or basic inventory work.

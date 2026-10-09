// src/hook.ts
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";

// src/host.ts
import { execFileSync } from "node:child_process";

// src/text.ts
function slug(text2, maxLength = 48) {
  return text2.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, maxLength).replace(/^-+|-+$/g, "");
}
function normalizeError(text2) {
  return text2.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

// src/check.ts
var GROUP = process.platform !== "win32";

// src/parse.ts
var InputError = class extends Error {
};

// src/workflow.ts
import { randomBytes } from "node:crypto";

// node_modules/@altinokdarici/p-graph/dist/errors.js
var PriorityGraphError = class extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
};
var NodeNotFoundError = class extends PriorityGraphError {
  id;
  constructor(id) {
    super(`Node "${id}" does not exist.`);
    this.id = id;
  }
};
var DependencyNotFoundError = class extends PriorityGraphError {
  id;
  dependsOn;
  constructor(id, dependsOn) {
    super(`Node "${id}" does not depend on "${dependsOn}".`);
    this.id = id;
    this.dependsOn = dependsOn;
  }
};
var DuplicateNodeError = class extends PriorityGraphError {
  id;
  constructor(id) {
    super(`Node "${id}" already exists.`);
    this.id = id;
  }
};
var CycleError = class extends PriorityGraphError {
  /** The offending cycle, e.g. `["a", "b", "a"]` means a depends on b which depends on a. */
  cycle;
  constructor(cycle) {
    super(`Dependency cycle detected: ${cycle.join(" -> ")}.`);
    this.cycle = cycle;
  }
};
var InvalidStateError = class extends PriorityGraphError {
  id;
  state;
  constructor(id, state, action) {
    super(`Cannot ${action} node "${id}" while it is ${state}.`);
    this.id = id;
    this.state = state;
  }
};
var InvalidSnapshotError = class extends PriorityGraphError {
};
var StoreError = class extends PriorityGraphError {
  cause;
  constructor(cause) {
    super(`The graph store failed to apply changes: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.cause = cause;
  }
};

// node_modules/@altinokdarici/p-graph/dist/heap.js
var IndexedHeap = class {
  #items = [];
  #before;
  /** @param before Returns true when `a` must be dequeued before `b`. */
  constructor(before2) {
    this.#before = before2;
  }
  get size() {
    return this.#items.length;
  }
  peek() {
    return this.#items[0];
  }
  has(item) {
    return item.heapIndex >= 0 && this.#items[item.heapIndex] === item;
  }
  push(item) {
    item.heapIndex = this.#items.length;
    this.#items.push(item);
    this.#siftUp(item.heapIndex);
  }
  pop() {
    const top = this.#items[0];
    if (top !== void 0) {
      this.remove(top);
    }
    return top;
  }
  remove(item) {
    if (!this.has(item)) {
      return false;
    }
    const index = item.heapIndex;
    const last = this.#items.pop();
    item.heapIndex = -1;
    if (last !== item) {
      this.#items[index] = last;
      last.heapIndex = index;
      this.#restore(index);
    }
    return true;
  }
  /** Re-establishes heap order after the ordering key of `item` changed. */
  update(item) {
    if (this.has(item)) {
      this.#restore(item.heapIndex);
    }
  }
  clear() {
    for (const item of this.#items) {
      item.heapIndex = -1;
    }
    this.#items.length = 0;
  }
  #restore(index) {
    if (!this.#siftUp(index)) {
      this.#siftDown(index);
    }
  }
  #siftUp(index) {
    const items = this.#items;
    const item = items[index];
    let moved = false;
    while (index > 0) {
      const parentIndex = index - 1 >> 1;
      const parent = items[parentIndex];
      if (!this.#before(item, parent)) {
        break;
      }
      items[index] = parent;
      parent.heapIndex = index;
      index = parentIndex;
      moved = true;
    }
    items[index] = item;
    item.heapIndex = index;
    return moved;
  }
  #siftDown(index) {
    const items = this.#items;
    const length = items.length;
    const item = items[index];
    for (; ; ) {
      const left = 2 * index + 1;
      if (left >= length) {
        break;
      }
      const right = left + 1;
      let child = left;
      if (right < length && this.#before(items[right], items[left])) {
        child = right;
      }
      const childItem = items[child];
      if (!this.#before(childItem, item)) {
        break;
      }
      items[index] = childItem;
      childItem.heapIndex = index;
      index = child;
    }
    items[index] = item;
    item.heapIndex = index;
  }
};

// node_modules/@altinokdarici/p-graph/dist/priority-graph.js
var NODE_STATES = ["pending", "ready", "in-progress", "completed"];
var before = (a, b) => a.effectivePriority > b.effectivePriority || a.effectivePriority === b.effectivePriority && a.order < b.order;
var PriorityGraph = class _PriorityGraph {
  #nodes = /* @__PURE__ */ new Map();
  #heap = new IndexedHeap(before);
  #counts = {
    pending: 0,
    ready: 0,
    "in-progress": 0,
    completed: 0
  };
  #inheritPriority;
  #defaultPriority;
  #store;
  #nextOrder = 0;
  #batch = [];
  #queue = [];
  #pumping = false;
  #inflight;
  #storeError;
  constructor(options = {}) {
    this.#inheritPriority = options.inheritPriority ?? false;
    this.#defaultPriority = options.defaultPriority ?? 0;
    assertPriority(this.#defaultPriority);
    this.#store = options.store;
  }
  /**
   * Restores a graph from a snapshot (for example one assembled from database
   * rows). `pending`/`ready` states and effective priorities are recomputed
   * from the dependencies. Loading does not emit changes to the store.
   */
  static fromSnapshot(snapshot, options = {}) {
    const graph = new _PriorityGraph(options);
    graph.#load(snapshot);
    return graph;
  }
  /** Total number of nodes, in any state. */
  get size() {
    return this.#nodes.size;
  }
  /** True when every node is completed (or the graph is empty). */
  get isComplete() {
    return this.#counts.completed === this.#nodes.size;
  }
  /** The error that made the store diverge from the graph, if any. */
  get storeError() {
    return this.#storeError;
  }
  /** Number of nodes in `state`, or of all nodes when omitted. */
  count(state) {
    return state === void 0 ? this.#nodes.size : this.#counts[state];
  }
  has(id) {
    return this.#nodes.has(id);
  }
  get(id) {
    const entry = this.#nodes.get(id);
    return entry && this.#view(entry);
  }
  /** Nodes in insertion order, optionally filtered by state. */
  *nodes(state) {
    for (const entry of this.#nodes.values()) {
      if (state === void 0 || entry.state === state) {
        yield this.#view(entry);
      }
    }
  }
  dependenciesOf(id) {
    return [...this.#require(id).dependencies.keys()];
  }
  dependentsOf(id) {
    return [...this.#require(id).dependents];
  }
  /** Edges from `id` to each of its dependencies, with their data. */
  dependencyEdges(id) {
    const entry = this.#require(id);
    return [...entry.dependencies].map(([dependsOn, data]) => toEdge(id, dependsOn, data));
  }
  /** Edges from each node that depends on `id` to `id`, with their data. */
  dependentEdges(id) {
    const entry = this.#require(id);
    return [...this.#entries(entry.dependents)].map((dependent) => toEdge(dependent.id, id, dependent.dependencies.get(id)));
  }
  /**
   * Adds a node. It is `ready` immediately unless one of `dependsOn` is not
   * completed yet. Dependencies must already exist. Each dependency is an id
   * or `{ id, data }`; if one is listed twice, the first occurrence wins.
   */
  addNode(id, data, options = {}) {
    this.#assertWritable();
    if (typeof id !== "string") {
      throw new TypeError(`Node id must be a string, got ${typeof id}.`);
    }
    if (this.#nodes.has(id)) {
      throw new DuplicateNodeError(id);
    }
    const priority = options.priority ?? this.#defaultPriority;
    assertPriority(priority);
    if (typeof options.dependsOn === "string") {
      throw new TypeError("dependsOn must be an array of node ids, not a string.");
    }
    const dependencies = /* @__PURE__ */ new Map();
    for (const spec of options.dependsOn ?? []) {
      const [dependency, edgeData] = parseDependency(spec);
      this.#require(dependency);
      if (!dependencies.has(dependency)) {
        dependencies.set(dependency, edgeData);
      }
    }
    return this.#mutate(() => {
      const entry = this.#createEntry(id, data, priority, this.#nextOrder++, dependencies);
      for (const dependency of dependencies.keys()) {
        const target = this.#nodes.get(dependency);
        target.dependents.add(id);
        if (target.state !== "completed") {
          entry.unmet++;
        }
      }
      entry.state = entry.unmet === 0 ? "ready" : "pending";
      this.#counts[entry.state]++;
      if (entry.state === "ready") {
        this.#heap.push(entry);
      }
      this.#record({ type: "node-added", node: toRecord(entry) });
      for (const [dependency, edgeData] of dependencies) {
        this.#record(dependencyAdded(id, dependency, edgeData));
      }
      this.#refresh(this.#entries(dependencies.keys()));
      return this.#view(entry);
    });
  }
  /**
   * Removes a node and all of its edges. Nodes that only waited on it become
   * ready. Returns false when the node does not exist.
   */
  removeNode(id) {
    this.#assertWritable();
    const entry = this.#nodes.get(id);
    if (!entry) {
      return false;
    }
    this.#mutate(() => this.#remove(entry));
    return true;
  }
  /** Removes every completed node; useful to bound memory in long-lived graphs. */
  pruneCompleted() {
    this.#assertWritable();
    const completed = [...this.#nodes.values()].filter((entry) => entry.state === "completed");
    this.#mutate(() => {
      for (const entry of completed) {
        this.#remove(entry);
      }
    });
    return completed.length;
  }
  setPriority(id, priority) {
    this.#assertWritable();
    const entry = this.#require(id);
    assertPriority(priority);
    if (entry.priority === priority) {
      return;
    }
    this.#mutate(() => {
      entry.priority = priority;
      this.#recordUpdate(entry, "priority");
      this.#refresh([entry]);
    });
  }
  setData(id, data) {
    this.#assertWritable();
    const entry = this.#require(id);
    this.#mutate(() => {
      entry.data = data;
      this.#recordUpdate(entry, "data");
    });
  }
  /**
   * Makes `id` wait for `dependsOn`. Only nodes that have not started
   * (`pending` or `ready`) can gain dependencies. `data` is stored on the edge.
   * Adding an existing edge is a no-op (its data is left unchanged; use
   * `setDependencyData`). Throws {@link CycleError} if the edge would create a
   * cycle.
   */
  addDependency(id, dependsOn, data) {
    this.#assertWritable();
    const entry = this.#require(id);
    const target = this.#require(dependsOn);
    if (entry.dependencies.has(dependsOn)) {
      return;
    }
    if (entry.state !== "pending" && entry.state !== "ready") {
      throw new InvalidStateError(id, entry.state, "add a dependency to");
    }
    const cycle = this.#findPath(target, entry);
    if (cycle) {
      throw new CycleError([id, ...cycle]);
    }
    this.#mutate(() => {
      entry.dependencies.set(dependsOn, data);
      target.dependents.add(id);
      this.#record(dependencyAdded(id, dependsOn, data));
      if (target.state !== "completed") {
        entry.unmet++;
        if (entry.state === "ready") {
          this.#heap.remove(entry);
          this.#setState(entry, "pending");
        }
      }
      this.#refresh([target]);
    });
  }
  /**
   * Replaces the data of the edge `id` -> `dependsOn`, in any node state.
   * Throws {@link DependencyNotFoundError} if the edge does not exist.
   */
  setDependencyData(id, dependsOn, data) {
    this.#assertWritable();
    const entry = this.#require(id);
    this.#require(dependsOn);
    if (!entry.dependencies.has(dependsOn)) {
      throw new DependencyNotFoundError(id, dependsOn);
    }
    this.#mutate(() => {
      entry.dependencies.set(dependsOn, data);
      this.#record({ type: "dependency-updated", id, dependsOn, data });
    });
  }
  /** Returns false when the edge does not exist. */
  removeDependency(id, dependsOn) {
    this.#assertWritable();
    const entry = this.#require(id);
    const target = this.#require(dependsOn);
    if (!entry.dependencies.has(dependsOn)) {
      return false;
    }
    this.#mutate(() => {
      entry.dependencies.delete(dependsOn);
      target.dependents.delete(id);
      this.#record({ type: "dependency-removed", id, dependsOn });
      if (target.state !== "completed") {
        this.#satisfy(entry);
      }
      this.#refresh([target]);
    });
    return true;
  }
  /** The node `dequeue()` would return, without changing anything. */
  peek() {
    const entry = this.#heap.peek();
    return entry && this.#view(entry);
  }
  /**
   * Takes the highest-priority ready node and marks it `in-progress`. Call
   * `complete()` (or `requeue()`) when done with it. Returns undefined when no
   * node is ready.
   */
  dequeue() {
    this.#assertWritable();
    const entry = this.#heap.peek();
    if (!entry) {
      return void 0;
    }
    return this.#mutate(() => {
      this.#heap.remove(entry);
      this.#setState(entry, "in-progress");
      return this.#view(entry);
    });
  }
  /**
   * Marks an `in-progress` node as completed. Returns the ids of the nodes that
   * became ready as a result.
   */
  complete(id) {
    this.#assertWritable();
    const entry = this.#require(id);
    if (entry.state !== "in-progress") {
      throw new InvalidStateError(id, entry.state, "complete");
    }
    return this.#mutate(() => {
      this.#setState(entry, "completed");
      const unblocked = [];
      for (const dependent of this.#entries(entry.dependents)) {
        if (this.#satisfy(dependent)) {
          unblocked.push(dependent.id);
        }
      }
      return unblocked;
    });
  }
  /** Puts an `in-progress` node back into the queue, e.g. to retry it. */
  requeue(id) {
    this.#assertWritable();
    const entry = this.#require(id);
    if (entry.state !== "in-progress") {
      throw new InvalidStateError(id, entry.state, "requeue");
    }
    this.#mutate(() => {
      this.#setState(entry, "ready");
      this.#heap.push(entry);
    });
  }
  /**
   * Yields ready nodes in priority order until none are left, completing each
   * node when the consumer asks for the next one (unless the consumer already
   * completed, requeued or removed it). Nodes added or unblocked during
   * traversal are picked up immediately. If the loop exits early, the last
   * yielded node stays `in-progress`.
   */
  *traverse() {
    for (let node = this.dequeue(); node; node = this.dequeue()) {
      yield node;
      if (this.#nodes.get(node.id)?.state === "in-progress") {
        this.complete(node.id);
      }
    }
  }
  /** Full plain-object copy of the graph. Node data is not cloned. */
  toSnapshot() {
    const nodes = [];
    const dependencies = [];
    for (const entry of this.#nodes.values()) {
      nodes.push(toRecord(entry));
      for (const [dependsOn, data] of entry.dependencies) {
        dependencies.push(toEdge(entry.id, dependsOn, data));
      }
    }
    return { version: 1, nodes, dependencies };
  }
  /**
   * Resolves once every change has been applied by the store. Rejects with a
   * {@link StoreError} if the store failed.
   */
  async flush() {
    while (this.#inflight) {
      await this.#inflight;
    }
    if (this.#storeError) {
      throw this.#storeError;
    }
  }
  // --- internals -----------------------------------------------------------
  #createEntry(id, data, priority, order, dependencies) {
    const entry = {
      id,
      data,
      priority,
      effectivePriority: priority,
      state: "pending",
      order,
      dependencies,
      dependents: /* @__PURE__ */ new Set(),
      unmet: 0,
      heapIndex: -1
    };
    this.#nodes.set(id, entry);
    return entry;
  }
  #remove(entry) {
    for (const dependency of this.#entries(entry.dependencies.keys())) {
      dependency.dependents.delete(entry.id);
      this.#record({ type: "dependency-removed", id: entry.id, dependsOn: dependency.id });
    }
    for (const dependent of this.#entries(entry.dependents)) {
      dependent.dependencies.delete(entry.id);
      this.#record({ type: "dependency-removed", id: dependent.id, dependsOn: entry.id });
    }
    this.#heap.remove(entry);
    this.#nodes.delete(entry.id);
    this.#counts[entry.state]--;
    this.#record({ type: "node-removed", id: entry.id });
    if (entry.state !== "completed") {
      for (const dependent of this.#entries(entry.dependents)) {
        this.#satisfy(dependent);
      }
    }
    this.#refresh(this.#entries(entry.dependencies.keys()));
  }
  /** One unmet dependency of `entry` went away. Returns true if it became ready. */
  #satisfy(entry) {
    entry.unmet--;
    if (entry.unmet === 0 && entry.state === "pending") {
      this.#setState(entry, "ready");
      this.#heap.push(entry);
      return true;
    }
    return false;
  }
  #setState(entry, state) {
    this.#counts[entry.state]--;
    this.#counts[state]++;
    entry.state = state;
    this.#recordUpdate(entry, "state");
  }
  /** Recomputes effective priorities starting at `start`, following dependencies. */
  #refresh(start) {
    const work = new Set(start);
    for (const entry of work) {
      work.delete(entry);
      let effective = entry.priority;
      if (this.#inheritPriority) {
        for (const dependent of this.#entries(entry.dependents)) {
          if (dependent.effectivePriority > effective) {
            effective = dependent.effectivePriority;
          }
        }
      }
      if (effective !== entry.effectivePriority) {
        entry.effectivePriority = effective;
        this.#heap.update(entry);
        if (this.#inheritPriority) {
          for (const dependency of this.#entries(entry.dependencies.keys())) {
            work.add(dependency);
          }
        }
      }
    }
  }
  /** Path of ids from `from` to `to` along dependency edges, if one exists. */
  #findPath(from, to) {
    const parents = /* @__PURE__ */ new Map([[from, void 0]]);
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === to) {
        const path = [];
        for (let step = current; step; step = parents.get(step)) {
          path.push(step.id);
        }
        return path.reverse();
      }
      if (current.state === "completed") {
        continue;
      }
      for (const next of this.#entries(current.dependencies.keys())) {
        if (!parents.has(next)) {
          parents.set(next, current);
          stack.push(next);
        }
      }
    }
    return void 0;
  }
  #load(snapshot) {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.nodes)) {
      throw new InvalidSnapshotError("Unsupported snapshot format; expected version 1.");
    }
    const records = [...snapshot.nodes].sort((a, b) => a.order - b.order);
    let previousOrder = -Infinity;
    for (const record2 of records) {
      if (typeof record2.id !== "string") {
        throw new InvalidSnapshotError("Every node must have a string id.");
      }
      if (this.#nodes.has(record2.id)) {
        throw new InvalidSnapshotError(`Duplicate node "${record2.id}".`);
      }
      if (!Number.isInteger(record2.order) || record2.order === previousOrder) {
        throw new InvalidSnapshotError(`Node "${record2.id}" has a missing or duplicate order.`);
      }
      if (!NODE_STATES.includes(record2.state)) {
        throw new InvalidSnapshotError(`Node "${record2.id}" has invalid state "${record2.state}".`);
      }
      assertPriority(record2.priority);
      previousOrder = record2.order;
      const entry = this.#createEntry(record2.id, record2.data, record2.priority, record2.order, /* @__PURE__ */ new Map());
      entry.state = record2.state;
      this.#nextOrder = record2.order + 1;
    }
    for (const { id, dependsOn, data } of snapshot.dependencies ?? []) {
      const entry = this.#nodes.get(id);
      const target = this.#nodes.get(dependsOn);
      if (!entry || !target) {
        throw new InvalidSnapshotError(`Dependency "${id}" -> "${dependsOn}" references a missing node.`);
      }
      entry.dependencies.set(dependsOn, data);
      target.dependents.add(id);
    }
    const order = [];
    const remaining = /* @__PURE__ */ new Map();
    for (const entry of this.#nodes.values()) {
      remaining.set(entry, entry.dependencies.size);
      if (entry.dependencies.size === 0) {
        order.push(entry);
      }
    }
    for (let i = 0; i < order.length; i++) {
      for (const dependent of this.#entries(order[i].dependents)) {
        const left = remaining.get(dependent) - 1;
        remaining.set(dependent, left);
        if (left === 0) {
          order.push(dependent);
        }
      }
    }
    if (order.length !== this.#nodes.size) {
      const isStuck = (entry) => remaining.get(entry) > 0;
      const path = [];
      let current = [...remaining.keys()].find(isStuck);
      while (!path.includes(current)) {
        path.push(current);
        current = [...this.#entries(current.dependencies.keys())].find(isStuck);
      }
      const cycle = path.slice(path.indexOf(current)).map((entry) => entry.id);
      throw new CycleError([...cycle, current.id]);
    }
    for (const entry of order) {
      for (const dependency of this.#entries(entry.dependencies.keys())) {
        if (dependency.state !== "completed") {
          entry.unmet++;
        }
      }
      if (entry.state === "pending" || entry.state === "ready") {
        entry.state = entry.unmet === 0 ? "ready" : "pending";
      } else if (entry.unmet > 0) {
        throw new InvalidSnapshotError(`Node "${entry.id}" is ${entry.state} but has dependencies that are not completed.`);
      }
      this.#counts[entry.state]++;
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const entry = order[i];
      if (this.#inheritPriority) {
        for (const dependent of this.#entries(entry.dependents)) {
          entry.effectivePriority = Math.max(entry.effectivePriority, dependent.effectivePriority);
        }
      }
      if (entry.state === "ready") {
        this.#heap.push(entry);
      }
    }
  }
  #require(id) {
    const entry = this.#nodes.get(id);
    if (!entry) {
      throw new NodeNotFoundError(id);
    }
    return entry;
  }
  *#entries(ids) {
    for (const id of ids) {
      yield this.#nodes.get(id);
    }
  }
  #view(entry) {
    return {
      id: entry.id,
      data: entry.data,
      priority: entry.priority,
      effectivePriority: entry.effectivePriority,
      state: entry.state,
      order: entry.order,
      dependencies: [...entry.dependencies.keys()]
    };
  }
  // --- change tracking -----------------------------------------------------
  #assertWritable() {
    if (this.#storeError) {
      throw this.#storeError;
    }
  }
  #mutate(operation) {
    try {
      return operation();
    } finally {
      this.#emit();
    }
  }
  #record(change) {
    if (this.#store) {
      this.#batch.push(change);
    }
  }
  #recordUpdate(entry, field) {
    if (this.#store) {
      this.#batch.push({ type: "node-updated", node: toRecord(entry), fields: [field] });
    }
  }
  #emit() {
    const batch = this.#batch;
    if (batch.length === 0) {
      return;
    }
    this.#batch = [];
    this.#queue.push(batch);
    if (!this.#pumping) {
      this.#pump();
    }
  }
  #pump() {
    const store = this.#store;
    this.#pumping = true;
    while (this.#queue.length > 0 && !this.#storeError) {
      const batch = this.#queue.shift();
      let result;
      try {
        result = store.apply(batch);
      } catch (cause) {
        this.#pumping = false;
        throw this.#fail(cause);
      }
      if (isPromiseLike(result)) {
        this.#inflight = Promise.resolve(result).then(() => {
          this.#inflight = void 0;
          try {
            this.#pump();
          } catch {
          }
        }, (cause) => {
          this.#inflight = void 0;
          this.#pumping = false;
          this.#fail(cause);
        });
        return;
      }
    }
    this.#pumping = false;
  }
  #fail(cause) {
    this.#queue.length = 0;
    this.#storeError = new StoreError(cause);
    return this.#storeError;
  }
};
function toRecord(entry) {
  return {
    id: entry.id,
    data: entry.data,
    priority: entry.priority,
    state: entry.state,
    order: entry.order
  };
}
function toEdge(id, dependsOn, data) {
  return data === void 0 ? { id, dependsOn } : { id, dependsOn, data };
}
function dependencyAdded(id, dependsOn, data) {
  return data === void 0 ? { type: "dependency-added", id, dependsOn } : { type: "dependency-added", id, dependsOn, data };
}
function parseDependency(spec) {
  if (typeof spec === "string") {
    return [spec, void 0];
  }
  if (typeof spec !== "object" || spec === null || typeof spec.id !== "string") {
    throw new TypeError("Each dependency must be a node id or an object with a string id.");
  }
  return [spec.id, spec.data];
}
function assertPriority(priority) {
  if (typeof priority !== "number" || Number.isNaN(priority)) {
    throw new TypeError(`Priority must be a number, got ${String(priority)}.`);
  }
}
function isPromiseLike(value) {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof value.then === "function";
}

// node_modules/@altinokdarici/p-graph/dist/apply-changes.js
function applyChanges(snapshot, changes) {
  for (const change of changes) {
    switch (change.type) {
      case "node-added":
        snapshot.nodes.push({ ...change.node });
        break;
      case "node-updated": {
        const index = snapshot.nodes.findIndex((node) => node.id === change.node.id);
        if (index >= 0) {
          snapshot.nodes[index] = { ...change.node };
        }
        break;
      }
      case "node-removed":
        snapshot.nodes = snapshot.nodes.filter((node) => node.id !== change.id);
        break;
      case "dependency-added":
        snapshot.dependencies.push(toEdge2(change.id, change.dependsOn, change.data));
        break;
      case "dependency-updated": {
        const index = snapshot.dependencies.findIndex((edge) => edge.id === change.id && edge.dependsOn === change.dependsOn);
        if (index >= 0) {
          snapshot.dependencies[index] = toEdge2(change.id, change.dependsOn, change.data);
        }
        break;
      }
      case "dependency-removed":
        snapshot.dependencies = snapshot.dependencies.filter((edge) => edge.id !== change.id || edge.dependsOn !== change.dependsOn);
        break;
    }
  }
  return snapshot;
}
function toEdge2(id, dependsOn, data) {
  return data === void 0 ? { id, dependsOn } : { id, dependsOn, data };
}

// src/store.ts
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
var WORKFLOWS_DIR = join(".copilot", "workflows");
var FileStore = class {
  path;
  doc;
  #queued = false;
  #writes = Promise.resolve();
  constructor(path, doc) {
    this.path = path;
    this.doc = doc;
  }
  apply(changes) {
    applyChanges(this.doc.graph, changes);
    this.touch();
  }
  /** Schedules a write of the current document. */
  touch() {
    if (this.#queued) return;
    this.#queued = true;
    this.#writes = this.#writes.catch(() => {
    }).then(() => {
      this.#queued = false;
      return writeJsonAtomic(this.path, this.doc);
    });
  }
  /** Resolves once the document on disk matches memory. */
  flush() {
    return this.#writes;
  }
};
function workflowPath(root, id) {
  return join(root, WORKFLOWS_DIR, `${id}.json`);
}
async function loadWorkflowFiles(root, onError) {
  const dir = join(root, WORKFLOWS_DIR);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const path = join(dir, name);
    try {
      const doc = JSON.parse(await readFile(path, "utf8"));
      if (doc.version !== 1 || typeof doc.id !== "string" || !doc.graph) throw new Error("not a workflow file");
      files.push({ path, doc });
    } catch (error) {
      onError(path, error);
    }
  }
  return files;
}
async function writeJsonAtomic(path, value) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {
  });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}
`);
  await rename(tmp, path);
}

// src/workflow.ts
var GOAL = "goal";
var GOAL_PRIORITY = Number.MIN_SAFE_INTEGER;
var OPTIONS = { inheritPriority: true };
var INTERRUPTED = "Interrupted before it reported (its subagent or session ended), so it may have done part of the work. Check the current state before you continue.";
var Workflow = class _Workflow {
  root;
  graph;
  #store;
  constructor(root, store, graph) {
    this.root = root;
    this.#store = store;
    this.graph = graph;
  }
  static create(root, input) {
    const goal = input.goal?.trim();
    if (!goal) throw new InputError("goal must be a non-empty string.");
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1) {
      throw new InputError("concurrency must be a whole number of at least 1.");
    }
    if (!input.tasks.length) throw new InputError("tasks must contain at least one step.");
    const id = `${slug(goal, 32) || "workflow"}-${randomBytes(2).toString("hex")}`;
    const doc = {
      version: 1,
      id,
      goal,
      concurrency: input.concurrency,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      graph: { version: 1, nodes: [], dependencies: [] }
    };
    const store = new FileStore(workflowPath(root, id), doc);
    const wf = new _Workflow(root, store, new PriorityGraph({ ...OPTIONS, store }));
    const goalData = { title: "Check the goal", instructions: "", attempts: 0 };
    if (input.goalCheck) goalData.check = input.goalCheck;
    wf.#transact((g) => {
      const ids = addTasks(g, input.tasks, { exactIds: true });
      g.addNode(GOAL, goalData, { priority: GOAL_PRIORITY, dependsOn: ids });
    });
    return wf;
  }
  static load(root, path, doc) {
    const store = new FileStore(path, doc);
    const graph = PriorityGraph.fromSnapshot(structuredClone(doc.graph), { ...OPTIONS, store });
    return new _Workflow(root, store, graph);
  }
  get id() {
    return this.#store.doc.id;
  }
  get goal() {
    return this.#store.doc.goal;
  }
  get concurrency() {
    return this.#store.doc.concurrency;
  }
  set concurrency(value) {
    if (!Number.isInteger(value) || value < 1) {
      throw new InputError("concurrency must be a whole number of at least 1.");
    }
    this.#store.doc.concurrency = value;
    this.#store.touch();
  }
  node(id) {
    const node = this.graph.get(id);
    if (!node) throw new InputError(`Workflow ${this.id} has no step "${id}".`);
    return node;
  }
  /** A step that asked the user something and has no answer yet. */
  isWaiting(node) {
    return node.state === "in-progress" && node.data.question !== void 0 && node.data.answer === void 0;
  }
  questions() {
    return [...this.graph.nodes("in-progress")].filter((node) => this.isWaiting(node)).map((node) => ({
      workflowId: this.id,
      nodeId: node.id,
      title: node.data.title,
      question: node.data.question
    }));
  }
  /** Steps handed out to a subagent that has not reported yet. */
  inFlight() {
    return [...this.graph.nodes("in-progress")].filter((node) => !this.isWaiting(node));
  }
  /** Puts steps whose subagent is gone back in the queue, telling their next attempt why. */
  recover() {
    const lost = this.inFlight();
    for (const node of lost) {
      this.graph.setData(node.id, { ...node.data, lastError: INTERRUPTED });
      this.graph.requeue(node.id);
    }
    return lost.length;
  }
  /** Takes the next ready step and counts the attempt. */
  startNext() {
    const node = this.graph.dequeue();
    if (!node) return void 0;
    this.graph.setData(node.id, { ...node.data, attempts: node.data.attempts + 1 });
    return this.graph.get(node.id);
  }
  /** Adds steps; `blocks` lists existing steps that must wait for them. Returns the new ids. */
  addTasks(tasks, blocks = []) {
    return this.#transact((g) => {
      for (const id of blocks) {
        const state = g.get(id)?.state;
        if (!state) throw new InputError(`Workflow ${this.id} has no step "${id}".`);
        if (id === GOAL && state === "in-progress") continue;
        if (state !== "pending" && state !== "ready") {
          throw new InputError(`Step "${id}" is ${state}; only steps that have not started can wait for new steps.`);
        }
      }
      const ids = addTasks(g, tasks);
      for (const id of blocks) {
        if (g.get(id).state !== "in-progress") for (const added of ids) g.addDependency(id, added);
      }
      return ids;
    });
  }
  /** The check to run before `apply`, when the report would complete the step. */
  checkFor(id, outcome) {
    if (effectiveStatus(id, outcome) !== "done" || this.#unfinishedBeforeGoal(id).length) return void 0;
    return this.node(id).data.check;
  }
  /** Steps added while the goal step ran that are not finished; the goal cannot complete before them. */
  #unfinishedBeforeGoal(id) {
    if (id !== GOAL) return [];
    return [...this.graph.nodes()].filter((n) => n.id !== GOAL && n.state !== "completed").map((n) => n.id);
  }
  /** Applies a step's report. `check` is the result of `checkFor`'s command. */
  apply(id, outcome, check) {
    this.#requireInProgress(id);
    switch (effectiveStatus(id, outcome)) {
      case "done": {
        const late = this.#unfinishedBeforeGoal(id);
        if (late.length) {
          return this.#tryTransact(id, (g) => {
            g.requeue(id);
            for (const dep of late) g.addDependency(id, dep, { label: "added while the goal ran" });
            return "blocked";
          });
        }
        if (check && !check.ok) return this.retryOrAsk(id, `The check failed:
${check.output}`);
        return this.#tryTransact(id, (g) => {
          const ids = addTasks(g, outcome.newTasks ?? [], { reuseUnfinished: true, self: id });
          for (const dependent of g.dependentsOf(id)) {
            if (dependent === GOAL) continue;
            for (const added of ids) g.addDependency(dependent, added, { label: `found by ${id}` });
          }
          g.setData(id, { ...g.get(id).data, result: outcome.summary || "(no summary)" });
          g.complete(id);
          return "done";
        });
      }
      case "blocked": {
        if (!outcome.newTasks?.length) {
          return this.retryOrAsk(id, "The step reported blocked without newTasks saying what has to happen first.");
        }
        const requested = id === GOAL ? requestedTitles(outcome.newTasks) : void 0;
        if (requested !== void 0) {
          const data = this.node(id).data;
          if (data.lastRequested?.join("\n") === requested.join("\n")) {
            this.graph.setData(id, { ...data, lastRequested: void 0 });
            this.#ask(
              id,
              `The goal check asked for the same work twice in a row (${requested.join(", ")}), so it is not added again. The work did not satisfy the goal check:
${outcome.summary || "(no summary)"}

How should it continue?`
            );
            return "question";
          }
        }
        const late = this.#unfinishedBeforeGoal(id);
        return this.#tryTransact(id, (g) => {
          g.requeue(id);
          if (requested !== void 0) g.setData(id, { ...g.get(id).data, lastRequested: requested });
          for (const added of addTasks(g, outcome.newTasks, { reuseUnfinished: true, self: id })) {
            g.addDependency(id, added, { label: "needed first" });
          }
          for (const dep of late) g.addDependency(id, dep, { label: "added while the goal ran" });
          return "blocked";
        });
      }
      case "needs_user": {
        if (!outcome.question) return this.retryOrAsk(id, "The step reported needs_user without a question.");
        this.#ask(id, outcome.question);
        return "question";
      }
      case "failed": {
        const reason = outcome.summary || "(no reason given)";
        this.graph.setData(id, { ...this.node(id).data, lastError: reason });
        this.#ask(id, `This step failed: ${reason}
How should it continue?`);
        return "question";
      }
    }
  }
  /** Retries a failed attempt, or asks the user when it failed the same way as the last one. */
  retryOrAsk(id, error) {
    const data = this.#requireInProgress(id).data;
    if (data.lastError !== void 0 && normalizeError(data.lastError) === normalizeError(error)) {
      this.#ask(id, `This step failed the same way twice:
${error}

How should it continue?`);
      return "question";
    }
    this.graph.setData(id, { ...data, lastError: error });
    this.graph.requeue(id);
    return "retry";
  }
  /**
   * Records the answer, and a replacement check if given, in the step's
   * history, and puts the step back in the queue. Returns the history entry.
   * The goal check can't be replaced: it is the definition of done.
   */
  answer(id, text2, check) {
    const node = this.node(id);
    if (!this.isWaiting(node)) throw new InputError(`Step "${id}" is not waiting for an answer.`);
    if (!text2.trim()) throw new InputError("answer must be a non-empty string.");
    if (check !== void 0 && id === GOAL) {
      throw new InputError("The goal check is the definition of done and can't be changed.");
    }
    const data = { ...node.data, answer: text2.trim() };
    let entry = `asked "${clip(node.data.question ?? "", 120)}", answered "${data.answer}"`;
    if (check !== void 0 && check !== node.data.check) {
      entry += `; check changed from ${node.data.check ? `\`${node.data.check}\`` : "none"} to \`${check}\``;
      data.check = check;
      delete data.lastError;
    }
    data.history = [...node.data.history ?? [], entry];
    this.graph.setData(id, data);
    this.graph.requeue(id);
    return entry;
  }
  /** Every answer and check change, per step. */
  changes() {
    return [...this.graph.nodes()].flatMap((node) => (node.data.history ?? []).map((entry) => `${node.id}: ${entry}`));
  }
  statusText() {
    const g = this.graph;
    const counts = ["completed", "in-progress", "ready", "pending"].map((state) => `${g.count(state)} ${state}`).join(", ");
    const lines = [`Workflow ${this.id}: ${this.goal}`, `Concurrency ${this.concurrency}. Steps: ${counts}.`];
    for (const node of g.nodes()) lines.push(this.#statusLine(node));
    const changes = this.changes();
    if (changes.length) lines.push("Answers and check changes:", ...changes.map((c) => `- ${c}`));
    return lines.join("\n");
  }
  flush() {
    return this.#store.flush();
  }
  #statusLine(node) {
    const d = node.data;
    const waiting = this.isWaiting(node);
    const state = waiting ? "waiting for user" : node.state;
    let line = `- [${state}] ${node.id}: ${d.title}`;
    if (d.attempts > 1) line += ` (attempt ${d.attempts})`;
    if (node.state === "pending") {
      const open = node.dependencies.filter((dep) => this.graph.get(dep)?.state !== "completed");
      line += `, waits for ${open.join(", ")}`;
    }
    if (waiting) line += `
    Question: ${d.question}`;
    else if (node.state === "completed") line += `
    ${clip(d.result ?? "")}`;
    else if (d.lastError) line += `
    Last error: ${clip(d.lastError)}`;
    return line;
  }
  #ask(id, question) {
    const data = this.node(id).data;
    this.graph.setData(id, { ...data, question, answer: void 0 });
  }
  #requireInProgress(id) {
    const node = this.node(id);
    if (node.state !== "in-progress") throw new Error(`Step "${id}" is ${node.state}, not in progress.`);
    return node;
  }
  /** Runs `change` on a scratch copy first, so a change that throws leaves the graph untouched. */
  #transact(change) {
    change(PriorityGraph.fromSnapshot(structuredClone(this.graph.toSnapshot()), OPTIONS));
    return change(this.graph);
  }
  #tryTransact(id, change) {
    try {
      return this.#transact(change);
    } catch (error) {
      return this.retryOrAsk(id, `The report could not be applied: ${error.message}`);
    }
  }
};
function effectiveStatus(id, outcome) {
  return id === GOAL && outcome.status === "done" && outcome.newTasks?.length ? "blocked" : outcome.status;
}
function requestedTitles(tasks) {
  return tasks.map((t) => t.title.replace(/\s+/g, " ").trim().toLowerCase()).sort();
}
function addTasks(g, tasks, { exactIds = false, reuseUnfinished = false, self = "" } = {}) {
  const keys = tasks.map((task) => slug(task.id));
  const ids = /* @__PURE__ */ new Map();
  const reused = /* @__PURE__ */ new Set();
  for (const [i, key] of keys.entries()) {
    if (!key) throw new InputError(`Step "${tasks[i].title}" needs an id made of letters or digits.`);
    if (key === GOAL) throw new InputError(`"${GOAL}" is reserved for the final goal check.`);
    if (ids.has(key)) throw new InputError(`Two steps use the id "${key}".`);
    let id = key;
    if (exactIds && g.has(id)) throw new InputError(`A step with id "${id}" already exists.`);
    const existing = g.get(id);
    if (reuseUnfinished && existing && id !== self && existing.state !== "completed") {
      ids.set(key, id);
      reused.add(id);
      continue;
    }
    for (let n = 2; g.has(id) || [...ids.values()].includes(id) || id !== key && keys.includes(id); n++) {
      id = `${key}-${n}`;
    }
    ids.set(key, id);
  }
  for (const [i, task] of tasks.entries()) {
    if (reused.has(ids.get(keys[i]))) continue;
    const data = { title: task.title, instructions: task.instructions, attempts: 0 };
    if (task.check) data.check = task.check;
    g.addNode(ids.get(keys[i]), data, task.priority === void 0 ? {} : { priority: task.priority });
  }
  for (const [i, task] of tasks.entries()) {
    const id = ids.get(keys[i]);
    if (reused.has(id)) continue;
    for (const dep of task.dependsOn ?? []) {
      const { id: ref, label } = typeof dep === "string" ? { id: dep, label: void 0 } : dep;
      const target = ids.get(slug(ref)) ?? (g.has(ref) ? ref : g.has(slug(ref)) ? slug(ref) : void 0);
      if (!target) throw new InputError(`Step "${id}" depends on "${ref}", which does not exist.`);
      if (target === GOAL) throw new InputError(`Step "${id}" cannot depend on the goal check.`);
      g.addDependency(id, target, label ? { label } : void 0);
    }
  }
  const goal = g.get(GOAL);
  if (goal && (goal.state === "pending" || goal.state === "ready")) {
    for (const id of ids.values()) g.addDependency(GOAL, id);
  }
  return [...ids.values()];
}
function clip(text2, max = 300) {
  const flat = text2.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}\u2026`;
}

// src/prompt.ts
var OUTCOME_SCHEMA = {
  type: "object",
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["done", "blocked", "needs_user", "failed"] },
    summary: { type: "string" },
    question: { type: "string" },
    newTasks: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "instructions"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          instructions: { type: "string" },
          check: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};
var REPORT = `## Report
Finish with a report:
- "done": the step is finished. In summary, say what you did and what later steps need to know (paths, branch names, decisions). If you noticed work outside this step, add it as newTasks instead of doing it.
- "blocked": something else must happen before this step can finish. Describe it as newTasks; this step runs again after them.
- "needs_user": only the user can decide something. Ask in question; this step runs again with the answer.
- "failed": the step cannot be done. Say why in summary.
Each newTasks item has an id (short, kebab-case), a title, self-contained instructions, and optionally a check (a shell command run from the project root that proves it is done) and dependsOn (ids of other new or existing steps).

End your final message with the report as one JSON object in a \`\`\`json block, matching this schema:
${"```"}json
${JSON.stringify(OUTCOME_SCHEMA)}
${"```"}`;

// src/host.ts
var ASK = `Ask the user each question (with the ask_user tool if you have it) and pass their answer to dw_answer. Never answer for them. If you can see the cause, such as a wrong check, tell the user what you found and propose the fix.`;
function questionsText(questions) {
  const lines = questions.map((q) => `- workflow ${q.workflowId}, step ${q.nodeId} (${q.title}): ${q.question}`);
  return `Steps waiting for the user's answer:
${lines.join("\n")}
${ASK}`;
}
function stateOf(wf) {
  if (wf.graph.isComplete) return "done";
  const parts = [];
  const out = wf.inFlight().length;
  if (out) parts.push(`${out} step(s) handed out to subagents`);
  const asking = wf.questions().length;
  if (asking) parts.push(`${asking} step(s) wait for the user's answer`);
  if (!out && wf.graph.count("ready")) parts.push("paused (dw_run resumes it)");
  return parts.join("; ") || "stuck";
}
async function loadAll(root) {
  const files = await loadWorkflowFiles(root, () => {
  });
  const all = [];
  for (const { path, doc } of files) {
    try {
      all.push(Workflow.load(root, path, doc));
    } catch {
    }
  }
  return all;
}
function projectRoot(cwd) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return top || cwd;
  } catch {
    return cwd;
  }
}

// src/hook.ts
async function main() {
  const input = JSON.parse(await readStdin());
  if (!input.cwd) return;
  const root = projectRoot(input.cwd);
  const all = await loadAll(root);
  if (!all.length) return;
  const parts = [];
  const questions = all.flatMap((wf) => wf.questions());
  if (questions.length) {
    parts.push(
      `Dynamic workflow ${questionsText(questions)} If the user's message answers one, pass it to dw_answer (cwd ${root}). Otherwise mention that these questions are open.`
    );
  }
  const left = all.filter((wf) => !wf.graph.isComplete && (wf.inFlight().length || wf.graph.count("ready")));
  const session = input.session_id ?? input.sessionId;
  if (left.length && session && firstTime(session, root)) {
    const lines = left.map((wf) => `- ${wf.id}: ${stateOf(wf)}. ${wf.goal}`);
    parts.push(
      `These dynamic workflows of ${root} have work left:
${lines.join("\n")}
Mention them to the user. If the user wants to continue one, call dw_run (it requeues steps whose subagents are gone). Never resume without the user asking.`
    );
  }
  if (parts.length) process.stdout.write(JSON.stringify({ additionalContext: parts.join("\n\n") }));
}
function firstTime(session, root) {
  const dir = join2(tmpdir(), "dynamic-workflows-hook");
  const key = createHash("sha256").update(`${session}
${root}`).digest("hex").slice(0, 32);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join2(dir, key), "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
main().catch(() => {
});

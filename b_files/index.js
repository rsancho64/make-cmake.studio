var growthbook = (function (exports) {
  'use strict';

  // Config settings
  const cacheSettings = {
    // Consider a fetch stale after 1 minute
    staleTTL: 1000 * 60,
    cacheKey: "gbFeaturesCache",
    backgroundSync: true,
    maxEntries: 10
  };
  const polyfills = {
    fetch: globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
    SubtleCrypto: globalThis.crypto ? globalThis.crypto.subtle : undefined,
    EventSource: globalThis.EventSource
  };
  const helpers = {
    fetchFeaturesCall: _ref => {
      let {
        host,
        clientKey,
        headers
      } = _ref;
      return polyfills.fetch("".concat(host, "/api/features/").concat(clientKey), {
        headers
      });
    },
    fetchRemoteEvalCall: _ref2 => {
      let {
        host,
        clientKey,
        payload,
        headers
      } = _ref2;
      const options = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers
        },
        body: JSON.stringify(payload)
      };
      return polyfills.fetch("".concat(host, "/api/eval/").concat(clientKey), options);
    },
    eventSourceCall: _ref3 => {
      let {
        host,
        clientKey,
        headers
      } = _ref3;
      if (headers) {
        return new polyfills.EventSource("".concat(host, "/sub/").concat(clientKey), {
          headers
        });
      }
      return new polyfills.EventSource("".concat(host, "/sub/").concat(clientKey));
    }
  };
  try {
    if (globalThis.localStorage) {
      polyfills.localStorage = globalThis.localStorage;
    }
  } catch (e) {
    // Ignore localStorage errors
  }

  // Global state
  const subscribedInstances = new Map();
  let cacheInitialized = false;
  const cache = new Map();
  const activeFetches = new Map();
  const streams = new Map();
  const supportsSSE = new Set();

  // Public functions
  function setPolyfills(overrides) {
    Object.assign(polyfills, overrides);
  }
  function configureCache(overrides) {
    Object.assign(cacheSettings, overrides);
    if (!cacheSettings.backgroundSync) {
      clearAutoRefresh();
    }
  }
  async function clearCache() {
    cache.clear();
    activeFetches.clear();
    clearAutoRefresh();
    cacheInitialized = false;
    await updatePersistentCache();
  }
  async function refreshFeatures(instance, timeout, skipCache, allowStale, updateInstance, backgroundSync) {
    if (!backgroundSync) {
      cacheSettings.backgroundSync = false;
    }
    const data = await fetchFeaturesWithCache(instance, allowStale, timeout, skipCache);
    updateInstance && data && (await refreshInstance(instance, data));
  }

  // Subscribe a GrowthBook instance to feature changes
  function subscribe(instance) {
    const key = getKey(instance);
    const subs = subscribedInstances.get(key) || new Set();
    subs.add(instance);
    subscribedInstances.set(key, subs);
  }
  function unsubscribe(instance) {
    subscribedInstances.forEach(s => s.delete(instance));
  }

  // Private functions
  async function updatePersistentCache() {
    try {
      if (!polyfills.localStorage) return;
      await polyfills.localStorage.setItem(cacheSettings.cacheKey, JSON.stringify(Array.from(cache.entries())));
    } catch (e) {
      // Ignore localStorage errors
    }
  }
  async function fetchFeaturesWithCache(instance, allowStale, timeout, skipCache) {
    const key = getKey(instance);
    const cacheKey = getCacheKey(instance);
    const now = new Date();
    await initializeCache();
    const existing = cache.get(cacheKey);
    if (existing && !skipCache && (allowStale || existing.staleAt > now)) {
      // Restore from cache whether SSE is supported
      if (existing.sse) supportsSSE.add(key);

      // Reload features in the background if stale
      if (existing.staleAt < now) {
        fetchFeatures(instance);
      }
      // Otherwise, if we don't need to refresh now, start a background sync
      else {
        startAutoRefresh(instance);
      }
      return existing.data;
    } else {
      return await promiseTimeout(fetchFeatures(instance), timeout);
    }
  }
  function getKey(instance) {
    const [apiHost, clientKey] = instance.getApiInfo();
    return "".concat(apiHost, "||").concat(clientKey);
  }
  function getCacheKey(instance) {
    const baseKey = getKey(instance);
    if (!instance.isRemoteEval()) return baseKey;
    const attributes = instance.getAttributes();
    const cacheKeyAttributes = instance.getCacheKeyAttributes() || Object.keys(instance.getAttributes());
    const ca = {};
    cacheKeyAttributes.forEach(key => {
      ca[key] = attributes[key];
    });
    const fv = instance.getForcedVariations();
    const url = instance.getUrl();
    return "".concat(baseKey, "||").concat(JSON.stringify({
      ca,
      fv,
      url
    }));
  }

  // Guarantee the promise always resolves within {timeout} ms
  // Resolved value will be `null` when there's an error or it takes too long
  // Note: The promise will continue running in the background, even if the timeout is hit
  function promiseTimeout(promise, timeout) {
    return new Promise(resolve => {
      let resolved = false;
      let timer;
      const finish = data => {
        if (resolved) return;
        resolved = true;
        timer && clearTimeout(timer);
        resolve(data || null);
      };
      if (timeout) {
        timer = setTimeout(() => finish(), timeout);
      }
      promise.then(data => finish(data)).catch(() => finish());
    });
  }

  // Populate cache from localStorage (if available)
  async function initializeCache() {
    if (cacheInitialized) return;
    cacheInitialized = true;
    try {
      if (polyfills.localStorage) {
        const value = await polyfills.localStorage.getItem(cacheSettings.cacheKey);
        if (value) {
          const parsed = JSON.parse(value);
          if (parsed && Array.isArray(parsed)) {
            parsed.forEach(_ref4 => {
              let [key, data] = _ref4;
              cache.set(key, {
                ...data,
                staleAt: new Date(data.staleAt)
              });
            });
          }
          cleanupCache();
        }
      }
    } catch (e) {
      // Ignore localStorage errors
    }
  }

  // Enforce the maxEntries limit
  function cleanupCache() {
    const entriesWithTimestamps = Array.from(cache.entries()).map(_ref5 => {
      let [key, value] = _ref5;
      return {
        key,
        staleAt: value.staleAt.getTime()
      };
    }).sort((a, b) => a.staleAt - b.staleAt);
    const entriesToRemoveCount = Math.min(Math.max(0, cache.size - cacheSettings.maxEntries), cache.size);
    for (let i = 0; i < entriesToRemoveCount; i++) {
      cache.delete(entriesWithTimestamps[i].key);
    }
  }

  // Called whenever new features are fetched from the API
  function onNewFeatureData(key, cacheKey, data) {
    // If contents haven't changed, ignore the update, extend the stale TTL
    const version = data.dateUpdated || "";
    const staleAt = new Date(Date.now() + cacheSettings.staleTTL);
    const existing = cache.get(cacheKey);
    if (existing && version && existing.version === version) {
      existing.staleAt = staleAt;
      updatePersistentCache();
      return;
    }

    // Update in-memory cache
    cache.set(cacheKey, {
      data,
      version,
      staleAt,
      sse: supportsSSE.has(key)
    });
    cleanupCache();
    // Update local storage (don't await this, just update asynchronously)
    updatePersistentCache();

    // Update features for all subscribed GrowthBook instances
    const instances = subscribedInstances.get(key);
    instances && instances.forEach(instance => refreshInstance(instance, data));
  }
  async function refreshInstance(instance, data) {
    await (data.encryptedExperiments ? instance.setEncryptedExperiments(data.encryptedExperiments, undefined, polyfills.SubtleCrypto) : instance.setExperiments(data.experiments || instance.getExperiments()));
    await (data.encryptedFeatures ? instance.setEncryptedFeatures(data.encryptedFeatures, undefined, polyfills.SubtleCrypto) : instance.setFeatures(data.features || instance.getFeatures()));
  }
  async function fetchFeatures(instance) {
    const {
      apiHost,
      apiRequestHeaders
    } = instance.getApiHosts();
    const clientKey = instance.getClientKey();
    const remoteEval = instance.isRemoteEval();
    const key = getKey(instance);
    const cacheKey = getCacheKey(instance);
    let promise = activeFetches.get(cacheKey);
    if (!promise) {
      const fetcher = remoteEval ? helpers.fetchRemoteEvalCall({
        host: apiHost,
        clientKey,
        payload: {
          attributes: instance.getAttributes(),
          forcedVariations: instance.getForcedVariations(),
          forcedFeatures: Array.from(instance.getForcedFeatures().entries()),
          url: instance.getUrl()
        },
        headers: apiRequestHeaders
      }) : helpers.fetchFeaturesCall({
        host: apiHost,
        clientKey,
        headers: apiRequestHeaders
      });

      // TODO: auto-retry if status code indicates a temporary error
      promise = fetcher.then(res => {
        if (res.headers.get("x-sse-support") === "enabled") {
          supportsSSE.add(key);
        }
        return res.json();
      }).then(data => {
        onNewFeatureData(key, cacheKey, data);
        startAutoRefresh(instance);
        activeFetches.delete(cacheKey);
        return data;
      }).catch(e => {
        activeFetches.delete(cacheKey);
        return Promise.resolve({});
      });
      activeFetches.set(cacheKey, promise);
    }
    return await promise;
  }

  // Watch a feature endpoint for changes
  // Will prefer SSE if enabled, otherwise fall back to cron
  function startAutoRefresh(instance) {
    const key = getKey(instance);
    const cacheKey = getCacheKey(instance);
    const {
      streamingHost,
      streamingHostRequestHeaders
    } = instance.getApiHosts();
    const clientKey = instance.getClientKey();
    if (cacheSettings.backgroundSync && supportsSSE.has(key) && polyfills.EventSource) {
      if (streams.has(key)) return;
      const channel = {
        src: null,
        cb: event => {
          try {
            if (event.type === "features-updated") {
              const instances = subscribedInstances.get(key);
              instances && instances.forEach(instance => {
                fetchFeatures(instance);
              });
            } else if (event.type === "features") {
              const json = JSON.parse(event.data);
              onNewFeatureData(key, cacheKey, json);
            }
            // Reset error count on success
            channel.errors = 0;
          } catch (e) {
            onSSEError(channel, streamingHost, clientKey, streamingHostRequestHeaders);
          }
        },
        errors: 0
      };
      streams.set(key, channel);
      enableChannel(channel, streamingHost, clientKey, streamingHostRequestHeaders);
    }
  }
  function onSSEError(channel, host, clientKey, headers) {
    channel.errors++;
    if (channel.errors > 3 || channel.src && channel.src.readyState === 2) {
      // exponential backoff after 4 errors, with jitter
      const delay = Math.pow(3, channel.errors - 3) * (1000 + Math.random() * 1000);
      disableChannel(channel);
      setTimeout(() => {
        enableChannel(channel, host, clientKey, headers);
      }, Math.min(delay, 300000)); // 5 minutes max
    }
  }

  function disableChannel(channel) {
    if (!channel.src) return;
    channel.src.onopen = null;
    channel.src.onerror = null;
    channel.src.close();
    channel.src = null;
  }
  function enableChannel(channel, host, clientKey, headers) {
    channel.src = helpers.eventSourceCall({
      host,
      clientKey,
      headers
    });
    channel.src.addEventListener("features", channel.cb);
    channel.src.addEventListener("features-updated", channel.cb);
    channel.src.onerror = () => {
      onSSEError(channel, host, clientKey, headers);
    };
    channel.src.onopen = () => {
      channel.errors = 0;
    };
  }
  function destroyChannel(channel, key) {
    disableChannel(channel);
    streams.delete(key);
  }
  function clearAutoRefresh() {
    // Clear list of which keys are auto-updated
    supportsSSE.clear();

    // Stop listening for any SSE events
    streams.forEach(destroyChannel);

    // Remove all references to GrowthBook instances
    subscribedInstances.clear();
  }

  var validAttributeName = /^[a-zA-Z:_][a-zA-Z0-9:_.-]*$/;
  var nullController = {
    revert: function revert() {}
  };
  var elements = /*#__PURE__*/new Map();
  var mutations = /*#__PURE__*/new Set();
  function getObserverInit(attr) {
    return attr === 'html' ? {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    } : {
      childList: false,
      subtree: false,
      attributes: true,
      attributeFilter: [attr]
    };
  }
  function getElementRecord(element) {
    var record = elements.get(element);
    if (!record) {
      record = {
        element: element,
        attributes: {}
      };
      elements.set(element, record);
    }
    return record;
  }
  function createElementPropertyRecord(el, attr, getCurrentValue, setValue, mutationRunner) {
    var currentValue = getCurrentValue(el);
    var record = {
      isDirty: false,
      originalValue: currentValue,
      virtualValue: currentValue,
      mutations: [],
      el: el,
      observer: new MutationObserver(function () {
        var currentValue = getCurrentValue(el);
        if (currentValue === record.virtualValue) return;
        record.originalValue = currentValue;
        mutationRunner(record);
      }),
      mutationRunner: mutationRunner,
      setValue: setValue,
      getCurrentValue: getCurrentValue
    };
    record.observer.observe(el, getObserverInit(attr));
    return record;
  }
  function queueIfNeeded(val, record) {
    var currentVal = record.getCurrentValue(record.el);
    record.virtualValue = val;
    if (val && typeof val !== 'string') {
      if (!currentVal || val.parentNode !== currentVal.parentNode || val.insertBeforeNode !== currentVal.insertBeforeNode) {
        record.isDirty = true;
        queueDOMUpdates();
      }
    } else if (val !== currentVal) {
      record.isDirty = true;
      queueDOMUpdates();
    }
  }
  function htmlMutationRunner(record) {
    var val = record.originalValue;
    record.mutations.forEach(function (m) {
      return val = m.mutate(val);
    });
    queueIfNeeded(getTransformedHTML(val), record);
  }
  function classMutationRunner(record) {
    var val = new Set(record.originalValue.split(/\s+/).filter(Boolean));
    record.mutations.forEach(function (m) {
      return m.mutate(val);
    });
    queueIfNeeded(Array.from(val).filter(Boolean).join(' '), record);
  }
  function attrMutationRunner(record) {
    var val = record.originalValue;
    record.mutations.forEach(function (m) {
      return val = m.mutate(val);
    });
    queueIfNeeded(val, record);
  }
  function _loadDOMNodes(_ref) {
    var parentSelector = _ref.parentSelector,
      insertBeforeSelector = _ref.insertBeforeSelector;
    var parentNode = document.querySelector(parentSelector);
    if (!parentNode) return null;
    var insertBeforeNode = insertBeforeSelector ? document.querySelector(insertBeforeSelector) : null;
    if (insertBeforeSelector && !insertBeforeNode) return null;
    return {
      parentNode: parentNode,
      insertBeforeNode: insertBeforeNode
    };
  }
  function positionMutationRunner(record) {
    var val = record.originalValue;
    record.mutations.forEach(function (m) {
      var selectors = m.mutate();
      var newNodes = _loadDOMNodes(selectors);
      val = newNodes || val;
    });
    queueIfNeeded(val, record);
  }
  var getHTMLValue = function getHTMLValue(el) {
    return el.innerHTML;
  };
  var setHTMLValue = function setHTMLValue(el, value) {
    return el.innerHTML = value;
  };
  function getElementHTMLRecord(element) {
    var elementRecord = getElementRecord(element);
    if (!elementRecord.html) {
      elementRecord.html = createElementPropertyRecord(element, 'html', getHTMLValue, setHTMLValue, htmlMutationRunner);
    }
    return elementRecord.html;
  }
  var getElementPosition = function getElementPosition(el) {
    return {
      parentNode: el.parentElement,
      insertBeforeNode: el.nextElementSibling
    };
  };
  var setElementPosition = function setElementPosition(el, value) {
    value.parentNode.insertBefore(el, value.insertBeforeNode);
  };
  function getElementPositionRecord(element) {
    var elementRecord = getElementRecord(element);
    if (!elementRecord.position) {
      elementRecord.position = createElementPropertyRecord(element, 'position', getElementPosition, setElementPosition, positionMutationRunner);
    }
    return elementRecord.position;
  }
  var setClassValue = function setClassValue(el, val) {
    return val ? el.className = val : el.removeAttribute('class');
  };
  var getClassValue = function getClassValue(el) {
    return el.className;
  };
  function getElementClassRecord(el) {
    var elementRecord = getElementRecord(el);
    if (!elementRecord.classes) {
      elementRecord.classes = createElementPropertyRecord(el, 'class', getClassValue, setClassValue, classMutationRunner);
    }
    return elementRecord.classes;
  }
  var getAttrValue = function getAttrValue(attrName) {
    return function (el) {
      var _el$getAttribute;
      return (_el$getAttribute = el.getAttribute(attrName)) != null ? _el$getAttribute : null;
    };
  };
  var setAttrValue = function setAttrValue(attrName) {
    return function (el, val) {
      return val !== null ? el.setAttribute(attrName, val) : el.removeAttribute(attrName);
    };
  };
  function getElementAttributeRecord(el, attr) {
    var elementRecord = getElementRecord(el);
    if (!elementRecord.attributes[attr]) {
      elementRecord.attributes[attr] = createElementPropertyRecord(el, attr, getAttrValue(attr), setAttrValue(attr), attrMutationRunner);
    }
    return elementRecord.attributes[attr];
  }
  function deleteElementPropertyRecord(el, attr) {
    var element = elements.get(el);
    if (!element) return;
    if (attr === 'html') {
      var _element$html, _element$html$observe;
      (_element$html = element.html) == null ? void 0 : (_element$html$observe = _element$html.observer) == null ? void 0 : _element$html$observe.disconnect();
      delete element.html;
    } else if (attr === 'class') {
      var _element$classes, _element$classes$obse;
      (_element$classes = element.classes) == null ? void 0 : (_element$classes$obse = _element$classes.observer) == null ? void 0 : _element$classes$obse.disconnect();
      delete element.classes;
    } else if (attr === 'position') {
      var _element$position, _element$position$obs;
      (_element$position = element.position) == null ? void 0 : (_element$position$obs = _element$position.observer) == null ? void 0 : _element$position$obs.disconnect();
      delete element.position;
    } else {
      var _element$attributes, _element$attributes$a, _element$attributes$a2;
      (_element$attributes = element.attributes) == null ? void 0 : (_element$attributes$a = _element$attributes[attr]) == null ? void 0 : (_element$attributes$a2 = _element$attributes$a.observer) == null ? void 0 : _element$attributes$a2.disconnect();
      delete element.attributes[attr];
    }
  }
  var transformContainer;
  function getTransformedHTML(html) {
    if (!transformContainer) {
      transformContainer = document.createElement('div');
    }
    transformContainer.innerHTML = html;
    return transformContainer.innerHTML;
  }
  function setPropertyValue(el, attr, m) {
    if (!m.isDirty) return;
    m.isDirty = false;
    var val = m.virtualValue;
    if (!m.mutations.length) {
      deleteElementPropertyRecord(el, attr);
    }
    m.setValue(el, val);
  }
  var raf = false;
  function setValue(m, el) {
    m.html && setPropertyValue(el, 'html', m.html);
    m.classes && setPropertyValue(el, 'class', m.classes);
    m.position && setPropertyValue(el, 'position', m.position);
    Object.keys(m.attributes).forEach(function (attr) {
      setPropertyValue(el, attr, m.attributes[attr]);
    });
  }
  function setValues() {
    raf = false;
    elements.forEach(setValue);
  }
  function queueDOMUpdates() {
    if (!raf) {
      raf = true;
      requestAnimationFrame(setValues);
    }
  } // find or create ElementPropertyRecord, add mutation to it, then run

  function startMutating(mutation, element) {
    var record = null;
    if (mutation.kind === 'html') {
      record = getElementHTMLRecord(element);
    } else if (mutation.kind === 'class') {
      record = getElementClassRecord(element);
    } else if (mutation.kind === 'attribute') {
      record = getElementAttributeRecord(element, mutation.attribute);
    } else if (mutation.kind === 'position') {
      record = getElementPositionRecord(element);
    }
    if (!record) return;
    record.mutations.push(mutation);
    record.mutationRunner(record);
  } // get (existing) ElementPropertyRecord, remove mutation from it, then run

  function stopMutating(mutation, el) {
    var record = null;
    if (mutation.kind === 'html') {
      record = getElementHTMLRecord(el);
    } else if (mutation.kind === 'class') {
      record = getElementClassRecord(el);
    } else if (mutation.kind === 'attribute') {
      record = getElementAttributeRecord(el, mutation.attribute);
    } else if (mutation.kind === 'position') {
      record = getElementPositionRecord(el);
    }
    if (!record) return;
    var index = record.mutations.indexOf(mutation);
    if (index !== -1) record.mutations.splice(index, 1);
    record.mutationRunner(record);
  } // maintain list of elements associated with mutation

  function refreshElementsSet(mutation) {
    var existingElements = new Set(mutation.elements);
    var newElements = new Set();
    var matchingElements = document.querySelectorAll(mutation.selector);
    matchingElements.forEach(function (el) {
      newElements.add(el);
      if (!existingElements.has(el)) {
        mutation.elements.add(el);
        startMutating(mutation, el);
      }
    });
    existingElements.forEach(function (el) {
      if (!newElements.has(el)) {
        mutation.elements["delete"](el);
        stopMutating(mutation, el);
      }
    });
  }
  function revertMutation(mutation) {
    mutation.elements.forEach(function (el) {
      return stopMutating(mutation, el);
    });
    mutation.elements.clear();
    mutations["delete"](mutation);
  }
  function refreshAllElementSets() {
    mutations.forEach(refreshElementsSet);
  } // Observer for elements that don't exist in the DOM yet

  var observer;
  function connectGlobalObserver() {
    if (typeof document === 'undefined') return;
    if (!observer) {
      observer = new MutationObserver(function () {
        refreshAllElementSets();
      });
    }
    refreshAllElementSets();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });
  } // run on init

  connectGlobalObserver();
  function newMutation(m) {
    // Not in a browser
    if (typeof document === 'undefined') return nullController; // add to global index of mutations

    mutations.add(m); // run refresh on init to establish list of elements associated w/ mutation

    refreshElementsSet(m);
    return {
      revert: function revert() {
        revertMutation(m);
      }
    };
  }
  function html(selector, mutate) {
    return newMutation({
      kind: 'html',
      elements: new Set(),
      mutate: mutate,
      selector: selector
    });
  }
  function position(selector, mutate) {
    return newMutation({
      kind: 'position',
      elements: new Set(),
      mutate: mutate,
      selector: selector
    });
  }
  function classes(selector, mutate) {
    return newMutation({
      kind: 'class',
      elements: new Set(),
      mutate: mutate,
      selector: selector
    });
  }
  function attribute(selector, attribute, mutate) {
    if (!validAttributeName.test(attribute)) return nullController;
    if (attribute === 'class' || attribute === 'className') {
      return classes(selector, function (classnames) {
        var mutatedClassnames = mutate(Array.from(classnames).join(' '));
        classnames.clear();
        if (!mutatedClassnames) return;
        mutatedClassnames.split(/\s+/g).filter(Boolean).forEach(function (c) {
          return classnames.add(c);
        });
      });
    }
    return newMutation({
      kind: 'attribute',
      attribute: attribute,
      elements: new Set(),
      mutate: mutate,
      selector: selector
    });
  }
  function declarative(_ref2) {
    var selector = _ref2.selector,
      action = _ref2.action,
      value = _ref2.value,
      attr = _ref2.attribute,
      parentSelector = _ref2.parentSelector,
      insertBeforeSelector = _ref2.insertBeforeSelector;
    if (attr === 'html') {
      if (action === 'append') {
        return html(selector, function (val) {
          return val + (value != null ? value : '');
        });
      } else if (action === 'set') {
        return html(selector, function () {
          return value != null ? value : '';
        });
      }
    } else if (attr === 'class') {
      if (action === 'append') {
        return classes(selector, function (val) {
          if (value) val.add(value);
        });
      } else if (action === 'remove') {
        return classes(selector, function (val) {
          if (value) val["delete"](value);
        });
      } else if (action === 'set') {
        return classes(selector, function (val) {
          val.clear();
          if (value) val.add(value);
        });
      }
    } else if (attr === 'position') {
      if (action === 'set' && parentSelector) {
        return position(selector, function () {
          return {
            insertBeforeSelector: insertBeforeSelector,
            parentSelector: parentSelector
          };
        });
      }
    } else {
      if (action === 'append') {
        return attribute(selector, attr, function (val) {
          return val !== null ? val + (value != null ? value : '') : value != null ? value : '';
        });
      } else if (action === 'set') {
        return attribute(selector, attr, function () {
          return value != null ? value : '';
        });
      } else if (action === 'remove') {
        return attribute(selector, attr, function () {
          return null;
        });
      }
    }
    return nullController;
  }
  var index = {
    html: html,
    classes: classes,
    attribute: attribute,
    position: position,
    declarative: declarative
  };

  function hashFnv32a(str) {
    let hval = 0x811c9dc5;
    const l = str.length;
    for (let i = 0; i < l; i++) {
      hval ^= str.charCodeAt(i);
      hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8) + (hval << 24);
    }
    return hval >>> 0;
  }
  function hash(seed, value, version) {
    // New unbiased hashing algorithm
    if (version === 2) {
      return hashFnv32a(hashFnv32a(seed + value) + "") % 10000 / 10000;
    }
    // Original biased hashing algorithm (keep for backwards compatibility)
    if (version === 1) {
      return hashFnv32a(value + seed) % 1000 / 1000;
    }

    // Unknown hash version
    return null;
  }
  function getEqualWeights(n) {
    if (n <= 0) return [];
    return new Array(n).fill(1 / n);
  }
  function inRange(n, range) {
    return n >= range[0] && n < range[1];
  }
  function inNamespace(hashValue, namespace) {
    const n = hash("__" + namespace[0], hashValue, 1);
    if (n === null) return false;
    return n >= namespace[1] && n < namespace[2];
  }
  function chooseVariation(n, ranges) {
    for (let i = 0; i < ranges.length; i++) {
      if (inRange(n, ranges[i])) {
        return i;
      }
    }
    return -1;
  }
  function getUrlRegExp(regexString) {
    try {
      const escaped = regexString.replace(/([^\\])\//g, "$1\\/");
      return new RegExp(escaped);
    } catch (e) {
      console.error(e);
      return undefined;
    }
  }
  function isURLTargeted(url, targets) {
    if (!targets.length) return false;
    let hasIncludeRules = false;
    let isIncluded = false;
    for (let i = 0; i < targets.length; i++) {
      const match = _evalURLTarget(url, targets[i].type, targets[i].pattern);
      if (targets[i].include === false) {
        if (match) return false;
      } else {
        hasIncludeRules = true;
        if (match) isIncluded = true;
      }
    }
    return isIncluded || !hasIncludeRules;
  }
  function _evalSimpleUrlPart(actual, pattern, isPath) {
    try {
      // Escape special regex characters and change wildcard `_____` to `.*`
      let escaped = pattern.replace(/[*.+?^${}()|[\]\\]/g, "\\$&").replace(/_____/g, ".*");
      if (isPath) {
        // When matching pathname, make leading/trailing slashes optional
        escaped = "\\/?" + escaped.replace(/(^\/|\/$)/g, "") + "\\/?";
      }
      const regex = new RegExp("^" + escaped + "$", "i");
      return regex.test(actual);
    } catch (e) {
      return false;
    }
  }
  function _evalSimpleUrlTarget(actual, pattern) {
    try {
      // If a protocol is missing, but a host is specified, add `https://` to the front
      // Use "_____" as the wildcard since `*` is not a valid hostname in some browsers
      const expected = new URL(pattern.replace(/^([^:/?]*)\./i, "https://$1.").replace(/\*/g, "_____"), "https://_____");

      // Compare each part of the URL separately
      const comps = [[actual.host, expected.host, false], [actual.pathname, expected.pathname, true]];
      // We only want to compare hashes if it's explicitly being targeted
      if (expected.hash) {
        comps.push([actual.hash, expected.hash, false]);
      }
      expected.searchParams.forEach((v, k) => {
        comps.push([actual.searchParams.get(k) || "", v, false]);
      });

      // If any comparisons fail, the whole thing fails
      return !comps.some(data => !_evalSimpleUrlPart(data[0], data[1], data[2]));
    } catch (e) {
      return false;
    }
  }
  function _evalURLTarget(url, type, pattern) {
    try {
      const parsed = new URL(url, "https://_");
      if (type === "regex") {
        const regex = getUrlRegExp(pattern);
        if (!regex) return false;
        return regex.test(parsed.href) || regex.test(parsed.href.substring(parsed.origin.length));
      } else if (type === "simple") {
        return _evalSimpleUrlTarget(parsed, pattern);
      }
      return false;
    } catch (e) {
      return false;
    }
  }
  function getBucketRanges(numVariations, coverage, weights) {
    coverage = coverage === undefined ? 1 : coverage;

    // Make sure coverage is within bounds
    if (coverage < 0) {
      coverage = 0;
    } else if (coverage > 1) {
      coverage = 1;
    }

    // Default to equal weights if missing or invalid
    const equal = getEqualWeights(numVariations);
    weights = weights || equal;
    if (weights.length !== numVariations) {
      weights = equal;
    }

    // If weights don't add up to 1 (or close to it), default to equal weights
    const totalWeight = weights.reduce((w, sum) => sum + w, 0);
    if (totalWeight < 0.99 || totalWeight > 1.01) {
      weights = equal;
    }

    // Covert weights to ranges
    let cumulative = 0;
    return weights.map(w => {
      const start = cumulative;
      cumulative += w;
      return [start, start + coverage * w];
    });
  }
  function getQueryStringOverride(id, url, numVariations) {
    if (!url) {
      return null;
    }
    const search = url.split("?")[1];
    if (!search) {
      return null;
    }
    const match = search.replace(/#.*/, "") // Get rid of anchor
    .split("&") // Split into key/value pairs
    .map(kv => kv.split("=", 2)).filter(_ref => {
      let [k] = _ref;
      return k === id;
    }) // Look for key that matches the experiment id
    .map(_ref2 => {
      let [, v] = _ref2;
      return parseInt(v);
    }); // Parse the value into an integer

    if (match.length > 0 && match[0] >= 0 && match[0] < numVariations) return match[0];
    return null;
  }
  function isIncluded(include) {
    try {
      return include();
    } catch (e) {
      console.error(e);
      return false;
    }
  }
  const base64ToBuf = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
  async function decrypt(encryptedString, decryptionKey, subtle) {
    decryptionKey = decryptionKey || "";
    subtle = subtle || globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) {
      throw new Error("No SubtleCrypto implementation found");
    }
    try {
      const key = await subtle.importKey("raw", base64ToBuf(decryptionKey), {
        name: "AES-CBC",
        length: 128
      }, true, ["encrypt", "decrypt"]);
      const [iv, cipherText] = encryptedString.split(".");
      const plainTextBuffer = await subtle.decrypt({
        name: "AES-CBC",
        iv: base64ToBuf(iv)
      }, key, base64ToBuf(cipherText));
      return new TextDecoder().decode(plainTextBuffer);
    } catch (e) {
      throw new Error("Failed to decrypt");
    }
  }
  function paddedVersionString(input) {
    // Remove build info and leading `v` if any
    // Split version into parts (both core version numbers and pre-release tags)
    // "v1.2.3-rc.1+build123" -> ["1","2","3","rc","1"]
    const parts = input.replace(/(^v|\+.*$)/g, "").split(/[-.]/);

    // If it's SemVer without a pre-release, add `~` to the end
    // ["1","0","0"] -> ["1","0","0","~"]
    // "~" is the largest ASCII character, so this will make "1.0.0" greater than "1.0.0-beta" for example
    if (parts.length === 3) {
      parts.push("~");
    }

    // Left pad each numeric part with spaces so string comparisons will work ("9">"10", but " 9"<"10")
    // Then, join back together into a single string
    return parts.map(v => v.match(/^[0-9]+$/) ? v.padStart(5, " ") : v).join("-");
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const _regexCache = {};

  // The top-level condition evaluation function
  function evalCondition(obj, condition) {
    // Recursive condition
    if ("$or" in condition) {
      return evalOr(obj, condition["$or"]);
    }
    if ("$nor" in condition) {
      return !evalOr(obj, condition["$nor"]);
    }
    if ("$and" in condition) {
      return evalAnd(obj, condition["$and"]);
    }
    if ("$not" in condition) {
      return !evalCondition(obj, condition["$not"]);
    }

    // Condition is an object, keys are object paths, values are the condition for that path
    for (const [k, v] of Object.entries(condition)) {
      if (!evalConditionValue(v, getPath(obj, k))) return false;
    }
    return true;
  }

  // Return value at dot-separated path of an object
  function getPath(obj, path) {
    const parts = path.split(".");
    let current = obj;
    for (let i = 0; i < parts.length; i++) {
      if (current && typeof current === "object" && parts[i] in current) {
        current = current[parts[i]];
      } else {
        return null;
      }
    }
    return current;
  }

  // Transform a regex string into a real RegExp object
  function getRegex(regex) {
    if (!_regexCache[regex]) {
      _regexCache[regex] = new RegExp(regex.replace(/([^\\])\//g, "$1\\/"));
    }
    return _regexCache[regex];
  }

  // Evaluate a single value against a condition
  function evalConditionValue(condition, value) {
    // Simple equality comparisons
    if (typeof condition === "string") {
      return value + "" === condition;
    }
    if (typeof condition === "number") {
      return value * 1 === condition;
    }
    if (typeof condition === "boolean") {
      return !!value === condition;
    }
    if (condition === null) {
      return value === null;
    }
    if (Array.isArray(condition) || !isOperatorObject(condition)) {
      return JSON.stringify(value) === JSON.stringify(condition);
    }

    // This is a special operator condition and we should evaluate each one separately
    for (const op in condition) {
      if (!evalOperatorCondition(op, value, condition[op])) {
        return false;
      }
    }
    return true;
  }

  // If the object has only keys that start with '$'
  function isOperatorObject(obj) {
    const keys = Object.keys(obj);
    return keys.length > 0 && keys.filter(k => k[0] === "$").length === keys.length;
  }

  // Return the data type of a value
  function getType(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    const t = typeof v;
    if (["string", "number", "boolean", "object", "undefined"].includes(t)) {
      return t;
    }
    return "unknown";
  }

  // At least one element of actual must match the expected condition/value
  function elemMatch(actual, expected) {
    if (!Array.isArray(actual)) return false;
    const check = isOperatorObject(expected) ? v => evalConditionValue(expected, v) : v => evalCondition(v, expected);
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] && check(actual[i])) {
        return true;
      }
    }
    return false;
  }
  function isIn(actual, expected) {
    // Do an intersection is attribute is an array
    if (Array.isArray(actual)) {
      return actual.some(el => expected.includes(el));
    }
    return expected.includes(actual);
  }

  // Evaluate a single operator condition
  function evalOperatorCondition(operator, actual, expected) {
    switch (operator) {
      case "$veq":
        return paddedVersionString(actual) === paddedVersionString(expected);
      case "$vne":
        return paddedVersionString(actual) !== paddedVersionString(expected);
      case "$vgt":
        return paddedVersionString(actual) > paddedVersionString(expected);
      case "$vgte":
        return paddedVersionString(actual) >= paddedVersionString(expected);
      case "$vlt":
        return paddedVersionString(actual) < paddedVersionString(expected);
      case "$vlte":
        return paddedVersionString(actual) <= paddedVersionString(expected);
      case "$eq":
        return actual === expected;
      case "$ne":
        return actual !== expected;
      case "$lt":
        return actual < expected;
      case "$lte":
        return actual <= expected;
      case "$gt":
        return actual > expected;
      case "$gte":
        return actual >= expected;
      case "$exists":
        return expected ? actual !== null : actual === null;
      case "$in":
        if (!Array.isArray(expected)) return false;
        return isIn(actual, expected);
      case "$nin":
        if (!Array.isArray(expected)) return false;
        return !isIn(actual, expected);
      case "$not":
        return !evalConditionValue(expected, actual);
      case "$size":
        if (!Array.isArray(actual)) return false;
        return evalConditionValue(expected, actual.length);
      case "$elemMatch":
        return elemMatch(actual, expected);
      case "$all":
        if (!Array.isArray(actual)) return false;
        for (let i = 0; i < expected.length; i++) {
          let passed = false;
          for (let j = 0; j < actual.length; j++) {
            if (evalConditionValue(expected[i], actual[j])) {
              passed = true;
              break;
            }
          }
          if (!passed) return false;
        }
        return true;
      case "$regex":
        try {
          return getRegex(expected).test(actual);
        } catch (e) {
          return false;
        }
      case "$type":
        return getType(actual) === expected;
      default:
        console.error("Unknown operator: " + operator);
        return false;
    }
  }

  // Recursive $or rule
  function evalOr(obj, conditions) {
    if (!conditions.length) return true;
    for (let i = 0; i < conditions.length; i++) {
      if (evalCondition(obj, conditions[i])) {
        return true;
      }
    }
    return false;
  }

  // Recursive $and rule
  function evalAnd(obj, conditions) {
    for (let i = 0; i < conditions.length; i++) {
      if (!evalCondition(obj, conditions[i])) {
        return false;
      }
    }
    return true;
  }

  const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
  class GrowthBook {
    // context is technically private, but some tools depend on it so we can't mangle the name
    // _ctx below is a clone of this property that we use internally

    // Properties and methods that start with "_" are mangled by Terser (saves ~150 bytes)

    // eslint-disable-next-line

    constructor(context) {
      context = context || {};
      // These properties are all initialized in the constructor instead of above
      // This saves ~80 bytes in the final output
      this._ctx = this.context = context;
      this._renderer = null;
      this._trackedExperiments = new Set();
      this._trackedFeatures = {};
      this.debug = false;
      this._subscriptions = new Set();
      this._rtQueue = [];
      this._rtTimer = 0;
      this.ready = false;
      this._assigned = new Map();
      this._forcedFeatureValues = new Map();
      this._attributeOverrides = {};
      this._activeAutoExperiments = new Map();
      this._loadFeaturesCalled = false;
      if (context.remoteEval) {
        if (context.decryptionKey) {
          throw new Error("Encryption is not available for remoteEval");
        }
        if (!context.clientKey) {
          throw new Error("Missing clientKey");
        }
        let isGbHost = false;
        try {
          isGbHost = !!new URL(context.apiHost || "").hostname.match(/growthbook\.io$/i);
        } catch (e) {
          // ignore invalid URLs
        }
        if (isGbHost) {
          throw new Error("Cannot use remoteEval on GrowthBook Cloud");
        }
      } else {
        if (context.cacheKeyAttributes) {
          throw new Error("cacheKeyAttributes are only used for remoteEval");
        }
      }
      if (context.features) {
        this.ready = true;
      }
      if (isBrowser && context.enableDevMode) {
        window._growthbook = this;
        document.dispatchEvent(new Event("gbloaded"));
      }
      if (context.experiments) {
        this.ready = true;
        this._updateAllAutoExperiments();
      }
      if (context.clientKey && !context.remoteEval) {
        this._refresh({}, true, false);
      }
    }
    async loadFeatures(options) {
      if (options && options.autoRefresh) {
        // interpret deprecated autoRefresh option as subscribeToChanges
        this._ctx.subscribeToChanges = true;
      }
      this._loadFeaturesCalled = true;
      await this._refresh(options, true, true);
      if (this._canSubscribe()) {
        subscribe(this);
      }
    }
    async refreshFeatures(options) {
      await this._refresh(options, false, true);
    }
    getApiInfo() {
      return [this.getApiHosts().apiHost, this.getClientKey()];
    }
    getApiHosts() {
      const defaultHost = this._ctx.apiHost || "https://cdn.growthbook.io";
      return {
        apiHost: defaultHost.replace(/\/*$/, ""),
        streamingHost: (this._ctx.streamingHost || defaultHost).replace(/\/*$/, ""),
        apiRequestHeaders: this._ctx.apiHostRequestHeaders,
        streamingHostRequestHeaders: this._ctx.streamingHostRequestHeaders
      };
    }
    getClientKey() {
      return this._ctx.clientKey || "";
    }
    isRemoteEval() {
      return this._ctx.remoteEval || false;
    }
    getCacheKeyAttributes() {
      return this._ctx.cacheKeyAttributes;
    }
    async _refresh(options, allowStale, updateInstance) {
      options = options || {};
      if (!this._ctx.clientKey) {
        throw new Error("Missing clientKey");
      }
      await refreshFeatures(this, options.timeout, options.skipCache || this._ctx.enableDevMode, allowStale, updateInstance, this._ctx.backgroundSync !== false);
    }
    _render() {
      if (this._renderer) {
        this._renderer();
      }
    }
    setFeatures(features) {
      this._ctx.features = features;
      this.ready = true;
      this._render();
    }
    async setEncryptedFeatures(encryptedString, decryptionKey, subtle) {
      const featuresJSON = await decrypt(encryptedString, decryptionKey || this._ctx.decryptionKey, subtle);
      this.setFeatures(JSON.parse(featuresJSON));
    }
    setExperiments(experiments) {
      this._ctx.experiments = experiments;
      this.ready = true;
      this._updateAllAutoExperiments();
    }
    async setEncryptedExperiments(encryptedString, decryptionKey, subtle) {
      const experimentsJSON = await decrypt(encryptedString, decryptionKey || this._ctx.decryptionKey, subtle);
      this.setExperiments(JSON.parse(experimentsJSON));
    }
    setAttributes(attributes) {
      this._ctx.attributes = attributes;
      if (this._ctx.remoteEval) {
        this._refreshForRemoteEval();
        return;
      }
      this._render();
      this._updateAllAutoExperiments();
    }
    setAttributeOverrides(overrides) {
      this._attributeOverrides = overrides;
      if (this._ctx.remoteEval) {
        this._refreshForRemoteEval();
        return;
      }
      this._render();
      this._updateAllAutoExperiments();
    }
    setForcedVariations(vars) {
      this._ctx.forcedVariations = vars || {};
      if (this._ctx.remoteEval) {
        this._refreshForRemoteEval();
        return;
      }
      this._render();
      this._updateAllAutoExperiments();
    }

    // eslint-disable-next-line
    setForcedFeatures(map) {
      this._forcedFeatureValues = map;
      this._render();
    }
    setURL(url) {
      this._ctx.url = url;
      if (this._ctx.remoteEval) {
        this._refreshForRemoteEval().then(() => this._updateAllAutoExperiments(true));
        return;
      }
      this._updateAllAutoExperiments(true);
    }
    getAttributes() {
      return {
        ...this._ctx.attributes,
        ...this._attributeOverrides
      };
    }
    getForcedVariations() {
      return this._ctx.forcedVariations || {};
    }
    getForcedFeatures() {
      // eslint-disable-next-line
      return this._forcedFeatureValues || new Map();
    }
    getUrl() {
      return this._ctx.url || "";
    }
    getFeatures() {
      return this._ctx.features || {};
    }
    getExperiments() {
      return this._ctx.experiments || [];
    }
    subscribe(cb) {
      this._subscriptions.add(cb);
      return () => {
        this._subscriptions.delete(cb);
      };
    }
    _canSubscribe() {
      return this._ctx.backgroundSync !== false && this._ctx.subscribeToChanges;
    }
    async _refreshForRemoteEval() {
      if (!this._ctx.remoteEval) return;
      if (!this._loadFeaturesCalled) return;
      await this._refresh({}, false, true).catch(() => {
        // Ignore errors
      });
    }
    getAllResults() {
      return new Map(this._assigned);
    }
    destroy() {
      // Release references to save memory
      this._subscriptions.clear();
      this._assigned.clear();
      this._trackedExperiments.clear();
      this._trackedFeatures = {};
      this._rtQueue = [];
      if (this._rtTimer) {
        clearTimeout(this._rtTimer);
      }
      unsubscribe(this);
      if (isBrowser && window._growthbook === this) {
        delete window._growthbook;
      }

      // Undo any active auto experiments
      this._activeAutoExperiments.forEach(exp => {
        exp.undo();
      });
      this._activeAutoExperiments.clear();
    }
    setRenderer(renderer) {
      this._renderer = renderer;
    }
    forceVariation(key, variation) {
      this._ctx.forcedVariations = this._ctx.forcedVariations || {};
      this._ctx.forcedVariations[key] = variation;
      if (this._ctx.remoteEval) {
        this._refreshForRemoteEval();
        return;
      }
      this._updateAllAutoExperiments();
      this._render();
    }
    run(experiment) {
      const result = this._run(experiment, null);
      this._fireSubscriptions(experiment, result);
      return result;
    }
    triggerExperiment(key) {
      if (!this._ctx.experiments) return null;
      const exp = this._ctx.experiments.find(exp => exp.key === key);
      if (!exp || !exp.manual) return null;
      return this._runAutoExperiment(exp, true);
    }
    _runAutoExperiment(experiment, forceManual, forceRerun) {
      const key = experiment.key;
      const existing = this._activeAutoExperiments.get(key);

      // If this is a manual experiment and it's not already running, skip
      if (experiment.manual && !forceManual && !existing) return null;

      // Run the experiment
      const result = this.run(experiment);

      // A hash to quickly tell if the assigned value changed
      const valueHash = JSON.stringify(result.value);

      // If the changes are already active, no need to re-apply them
      if (!forceRerun && result.inExperiment && existing && existing.valueHash === valueHash) {
        return result;
      }

      // Undo any existing changes
      if (existing) this._undoActiveAutoExperiment(key);

      // Apply new changes
      if (result.inExperiment) {
        const undo = this._applyDOMChanges(result.value);
        if (undo) {
          this._activeAutoExperiments.set(experiment.key, {
            undo,
            valueHash
          });
        }
      }
      return result;
    }
    _undoActiveAutoExperiment(key) {
      const exp = this._activeAutoExperiments.get(key);
      if (exp) {
        exp.undo();
        this._activeAutoExperiments.delete(key);
      }
    }
    _updateAllAutoExperiments(forceRerun) {
      const experiments = this._ctx.experiments || [];

      // Stop any experiments that are no longer defined
      const keys = new Set(experiments.map(e => e.key));
      this._activeAutoExperiments.forEach((v, k) => {
        if (!keys.has(k)) {
          v.undo();
          this._activeAutoExperiments.delete(k);
        }
      });

      // Re-run all new/updated experiments
      experiments.forEach(exp => {
        this._runAutoExperiment(exp, false, forceRerun);
      });
    }
    _fireSubscriptions(experiment, result) {
      const key = experiment.key;

      // If assigned variation has changed, fire subscriptions
      const prev = this._assigned.get(key);
      // TODO: what if the experiment definition has changed?
      if (!prev || prev.result.inExperiment !== result.inExperiment || prev.result.variationId !== result.variationId) {
        this._assigned.set(key, {
          experiment,
          result
        });
        this._subscriptions.forEach(cb => {
          try {
            cb(experiment, result);
          } catch (e) {
            console.error(e);
          }
        });
      }
    }
    _trackFeatureUsage(key, res) {
      // Don't track feature usage that was forced via an override
      if (res.source === "override") return;

      // Only track a feature once, unless the assigned value changed
      const stringifiedValue = JSON.stringify(res.value);
      if (this._trackedFeatures[key] === stringifiedValue) return;
      this._trackedFeatures[key] = stringifiedValue;

      // Fire user-supplied callback
      if (this._ctx.onFeatureUsage) {
        try {
          this._ctx.onFeatureUsage(key, res);
        } catch (e) {
          // Ignore feature usage callback errors
        }
      }

      // In browser environments, queue up feature usage to be tracked in batches
      if (!isBrowser || !window.fetch) return;
      this._rtQueue.push({
        key,
        on: res.on
      });
      if (!this._rtTimer) {
        this._rtTimer = window.setTimeout(() => {
          // Reset the queue
          this._rtTimer = 0;
          const q = [...this._rtQueue];
          this._rtQueue = [];

          // Skip logging if a real-time usage key is not configured
          if (!this._ctx.realtimeKey) return;
          window.fetch("https://rt.growthbook.io/?key=".concat(this._ctx.realtimeKey, "&events=").concat(encodeURIComponent(JSON.stringify(q))), {
            cache: "no-cache",
            mode: "no-cors"
          }).catch(() => {
            // TODO: retry in case of network errors?
          });
        }, this._ctx.realtimeInterval || 2000);
      }
    }
    _getFeatureResult(key, value, source, ruleId, experiment, result) {
      const ret = {
        value,
        on: !!value,
        off: !value,
        source,
        ruleId: ruleId || ""
      };
      if (experiment) ret.experiment = experiment;
      if (result) ret.experimentResult = result;

      // Track the usage of this feature in real-time
      this._trackFeatureUsage(key, ret);
      return ret;
    }
    isOn(key) {
      return this.evalFeature(key).on;
    }
    isOff(key) {
      return this.evalFeature(key).off;
    }
    getFeatureValue(key, defaultValue) {
      const value = this.evalFeature(key).value;
      return value === null ? defaultValue : value;
    }

    /**
     * @deprecated Use {@link evalFeature}
     * @param id
     */
    // eslint-disable-next-line
    feature(id) {
      return this.evalFeature(id);
    }
    evalFeature(id) {
      // Global override
      if (this._forcedFeatureValues.has(id)) {
        return this._getFeatureResult(id, this._forcedFeatureValues.get(id), "override");
      }

      // Unknown feature id
      if (!this._ctx.features || !this._ctx.features[id]) {
        return this._getFeatureResult(id, null, "unknownFeature");
      }

      // Get the feature
      const feature = this._ctx.features[id];

      // Loop through the rules
      if (feature.rules) {
        for (const rule of feature.rules) {
          // If it's a conditional rule, skip if the condition doesn't pass
          if (rule.condition && !this._conditionPasses(rule.condition)) {
            continue;
          }
          // If there are filters for who is included (e.g. namespaces)
          if (rule.filters && this._isFilteredOut(rule.filters)) {
            continue;
          }

          // Feature value is being forced
          if ("force" in rule) {
            // If this is a percentage rollout, skip if not included
            if (!this._isIncludedInRollout(rule.seed || id, rule.hashAttribute, rule.range, rule.coverage, rule.hashVersion)) {
              continue;
            }

            // If this was a remotely evaluated experiment, fire the tracking callbacks
            if (rule.tracks) {
              rule.tracks.forEach(t => {
                this._track(t.experiment, t.result);
              });
            }
            return this._getFeatureResult(id, rule.force, "force", rule.id);
          }
          if (!rule.variations) {
            continue;
          }
          // For experiment rules, run an experiment
          const exp = {
            variations: rule.variations,
            key: rule.key || id
          };
          if ("coverage" in rule) exp.coverage = rule.coverage;
          if (rule.weights) exp.weights = rule.weights;
          if (rule.hashAttribute) exp.hashAttribute = rule.hashAttribute;
          if (rule.namespace) exp.namespace = rule.namespace;
          if (rule.meta) exp.meta = rule.meta;
          if (rule.ranges) exp.ranges = rule.ranges;
          if (rule.name) exp.name = rule.name;
          if (rule.phase) exp.phase = rule.phase;
          if (rule.seed) exp.seed = rule.seed;
          if (rule.hashVersion) exp.hashVersion = rule.hashVersion;
          if (rule.filters) exp.filters = rule.filters;

          // Only return a value if the user is part of the experiment
          const res = this._run(exp, id);
          this._fireSubscriptions(exp, res);
          if (res.inExperiment && !res.passthrough) {
            return this._getFeatureResult(id, res.value, "experiment", rule.id, exp, res);
          }
        }
      }

      // Fall back to using the default value
      return this._getFeatureResult(id, feature.defaultValue === undefined ? null : feature.defaultValue, "defaultValue");
    }
    _isIncludedInRollout(seed, hashAttribute, range, coverage, hashVersion) {
      if (!range && coverage === undefined) return true;
      const {
        hashValue
      } = this._getHashAttribute(hashAttribute);
      if (!hashValue) {
        return false;
      }
      const n = hash(seed, hashValue, hashVersion || 1);
      if (n === null) return false;
      return range ? inRange(n, range) : coverage !== undefined ? n <= coverage : true;
    }
    _conditionPasses(condition) {
      return evalCondition(this.getAttributes(), condition);
    }
    _isFilteredOut(filters) {
      return filters.some(filter => {
        const {
          hashValue
        } = this._getHashAttribute(filter.attribute);
        if (!hashValue) return true;
        const n = hash(filter.seed, hashValue, filter.hashVersion || 2);
        if (n === null) return true;
        return !filter.ranges.some(r => inRange(n, r));
      });
    }
    _run(experiment, featureId) {
      const key = experiment.key;
      const numVariations = experiment.variations.length;

      // 1. If experiment has less than 2 variations, return immediately
      if (numVariations < 2) {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 2. If the context is disabled, return immediately
      if (this._ctx.enabled === false) {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 2.5. Merge in experiment overrides from the context
      experiment = this._mergeOverrides(experiment);

      // 3. If a variation is forced from a querystring, return the forced variation
      const qsOverride = getQueryStringOverride(key, this._getContextUrl(), numVariations);
      if (qsOverride !== null) {
        return this._getResult(experiment, qsOverride, false, featureId);
      }

      // 4. If a variation is forced in the context, return the forced variation
      if (this._ctx.forcedVariations && key in this._ctx.forcedVariations) {
        const variation = this._ctx.forcedVariations[key];
        return this._getResult(experiment, variation, false, featureId);
      }

      // 5. Exclude if a draft experiment or not active
      if (experiment.status === "draft" || experiment.active === false) {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 6. Get the hash attribute and return if empty
      const {
        hashValue
      } = this._getHashAttribute(experiment.hashAttribute);
      if (!hashValue) {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 7. Exclude if user is filtered out (used to be called "namespace")
      if (experiment.filters) {
        if (this._isFilteredOut(experiment.filters)) {
          return this._getResult(experiment, -1, false, featureId);
        }
      } else if (experiment.namespace && !inNamespace(hashValue, experiment.namespace)) {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 7.5. Exclude if experiment.include returns false or throws
      if (experiment.include && !isIncluded(experiment.include)) {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 8. Exclude if condition is false
      if (experiment.condition && !this._conditionPasses(experiment.condition)) {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 8.1. Exclude if user is not in a required group
      if (experiment.groups && !this._hasGroupOverlap(experiment.groups)) {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 8.2. Old style URL targeting
      if (experiment.url && !this._urlIsValid(experiment.url)) {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 8.3. New, more powerful URL targeting
      if (experiment.urlPatterns && !isURLTargeted(this._getContextUrl(), experiment.urlPatterns)) {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 9. Get bucket ranges and choose variation
      const n = hash(experiment.seed || key, hashValue, experiment.hashVersion || 1);
      if (n === null) {
        return this._getResult(experiment, -1, false, featureId);
      }
      const ranges = experiment.ranges || getBucketRanges(numVariations, experiment.coverage === undefined ? 1 : experiment.coverage, experiment.weights);
      const assigned = chooseVariation(n, ranges);

      // 10. Return if not in experiment
      if (assigned < 0) {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 11. Experiment has a forced variation
      if ("force" in experiment) {
        return this._getResult(experiment, experiment.force === undefined ? -1 : experiment.force, false, featureId);
      }

      // 12. Exclude if in QA mode
      if (this._ctx.qaMode) {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 12.5. Exclude if experiment is stopped
      if (experiment.status === "stopped") {
        return this._getResult(experiment, -1, false, featureId);
      }

      // 13. Build the result object
      const result = this._getResult(experiment, assigned, true, featureId, n);

      // 14. Fire the tracking callback
      this._track(experiment, result);
      return result;
    }
    log(msg, ctx) {
      if (!this.debug) return;
      if (this._ctx.log) this._ctx.log(msg, ctx);else console.log(msg, ctx);
    }
    _track(experiment, result) {
      if (!this._ctx.trackingCallback) return;
      const key = experiment.key;

      // Make sure a tracking callback is only fired once per unique experiment
      const k = result.hashAttribute + result.hashValue + key + result.variationId;
      if (this._trackedExperiments.has(k)) return;
      this._trackedExperiments.add(k);
      try {
        this._ctx.trackingCallback(experiment, result);
      } catch (e) {
        console.error(e);
      }
    }
    _mergeOverrides(experiment) {
      const key = experiment.key;
      const o = this._ctx.overrides;
      if (o && o[key]) {
        experiment = Object.assign({}, experiment, o[key]);
        if (typeof experiment.url === "string") {
          experiment.url = getUrlRegExp(
          // eslint-disable-next-line
          experiment.url);
        }
      }
      return experiment;
    }
    _getHashAttribute(attr) {
      const hashAttribute = attr || "id";
      let hashValue = "";
      if (this._attributeOverrides[hashAttribute]) {
        hashValue = this._attributeOverrides[hashAttribute];
      } else if (this._ctx.attributes) {
        hashValue = this._ctx.attributes[hashAttribute] || "";
      } else if (this._ctx.user) {
        hashValue = this._ctx.user[hashAttribute] || "";
      }
      return {
        hashAttribute,
        hashValue
      };
    }
    _getResult(experiment, variationIndex, hashUsed, featureId, bucket) {
      let inExperiment = true;
      // If assigned variation is not valid, use the baseline and mark the user as not in the experiment
      if (variationIndex < 0 || variationIndex >= experiment.variations.length) {
        variationIndex = 0;
        inExperiment = false;
      }
      const {
        hashAttribute,
        hashValue
      } = this._getHashAttribute(experiment.hashAttribute);
      const meta = experiment.meta ? experiment.meta[variationIndex] : {};
      const res = {
        key: meta.key || "" + variationIndex,
        featureId,
        inExperiment,
        hashUsed,
        variationId: variationIndex,
        value: experiment.variations[variationIndex],
        hashAttribute,
        hashValue
      };
      if (meta.name) res.name = meta.name;
      if (bucket !== undefined) res.bucket = bucket;
      if (meta.passthrough) res.passthrough = meta.passthrough;
      return res;
    }
    _getContextUrl() {
      return this._ctx.url || (isBrowser ? window.location.href : "");
    }
    _urlIsValid(urlRegex) {
      const url = this._getContextUrl();
      if (!url) return false;
      const pathOnly = url.replace(/^https?:\/\//, "").replace(/^[^/]*\//, "/");
      if (urlRegex.test(url)) return true;
      if (urlRegex.test(pathOnly)) return true;
      return false;
    }
    _hasGroupOverlap(expGroups) {
      const groups = this._ctx.groups || {};
      for (let i = 0; i < expGroups.length; i++) {
        if (groups[expGroups[i]]) return true;
      }
      return false;
    }
    _applyDOMChanges(changes) {
      if (!isBrowser) return;
      const undo = [];
      if (changes.css) {
        const s = document.createElement("style");
        s.innerHTML = changes.css;
        document.head.appendChild(s);
        undo.push(() => s.remove());
      }
      if (changes.js) {
        const script = document.createElement("script");
        script.innerHTML = changes.js;
        document.body.appendChild(script);
        undo.push(() => script.remove());
      }
      if (changes.domMutations) {
        changes.domMutations.forEach(mutation => {
          undo.push(index.declarative(mutation).revert);
        });
      }
      return () => {
        undo.forEach(fn => fn());
      };
    }
  }

  exports.GrowthBook = GrowthBook;
  exports.clearCache = clearCache;
  exports.configureCache = configureCache;
  exports.helpers = helpers;
  exports.isURLTargeted = isURLTargeted;
  exports.setPolyfills = setPolyfills;

  Object.defineProperty(exports, '__esModule', { value: true });

  return exports;

})({});
//# sourceMappingURL=index.js.map

// -----------------------------------------------------------------------------
// mini-jsonschema.mjs — bağımlılıksız, küçük bir JSON Schema (draft 2020-12
// alt kümesi) doğrulayıcısı.
//
// NEDEN kendi doğrulayıcımızı yazıyoruz: scripts/ klasörünün kuralı "npm install
// gerektirmez". Ajv mükemmel bir kütüphanedir ama tek bir şema dosyasını
// doğrulamak için scripts/ altına bir bağımlılık ağacı indirmek, dersin
// "protokol basittir, kendin de yazabilirsin" mesajıyla çelişirdi.
//
// DESTEKLENEN anahtar kelimeler (steps.schema.json'un ihtiyaç duyduğu kadarı):
//   $ref (yalnızca "#" ve "#/$defs/<ad>"), $defs, type, enum, const,
//   properties, patternProperties, additionalProperties, required,
//   propertyNames, minProperties, maxProperties,
//   items, prefixItems, minItems, maxItems, uniqueItems,
//   minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf,
//   minLength, maxLength, pattern,
//   allOf, anyOf, oneOf, not, if/then/else
//
// DESTEKLENMEYEN: uzak $ref, $dynamicRef, format (yok sayılır), unevaluated*.
// Bir şemada desteklenmeyen bir anahtar kullanılırsa sessizce yok sayılır —
// bu yüzden şemayı yazan kişi buradaki listeye sadık kalmalıdır.
// -----------------------------------------------------------------------------

const TYPE_OF = (v) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  // JSON'da 3.0 bir "integer"dır; tam sayı kontrolünü ayrıca yapıyoruz.
  return typeof v;
};

function typeMatches(value, type) {
  const t = TYPE_OF(value);
  if (type === "integer") return t === "number" && Number.isInteger(value);
  if (type === "number") return t === "number";
  return t === type;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/** "#/$defs/Step" → root.$defs.Step. Yalnızca yerel referanslar desteklenir. */
function resolveRef(ref, root) {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) {
    throw new Error(`mini-jsonschema: yalnızca yerel $ref desteklenir, gelen: ${ref}`);
  }
  let cur = root;
  for (const rawSeg of ref.slice(2).split("/")) {
    // JSON Pointer kaçışları: ~1 = "/", ~0 = "~"
    const seg = rawSeg.replaceAll("~1", "/").replaceAll("~0", "~");
    if (cur == null || !(seg in cur)) throw new Error(`mini-jsonschema: çözülemeyen $ref: ${ref}`);
    cur = cur[seg];
  }
  return cur;
}

function pathJoin(base, seg) {
  return typeof seg === "number" ? `${base}[${seg}]` : base === "" ? seg : `${base}.${seg}`;
}

/**
 * @returns {{valid: boolean, errors: {path: string, message: string}[]}}
 */
export function validate(schema, data, { root = schema } = {}) {
  const errors = [];
  walk(schema, data, "", root, errors);
  return { valid: errors.length === 0, errors };
}

function walk(schema, data, dataPath, root, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push({ path: dataPath, message: "şema bu değeri kabul etmiyor (false)" });
    return;
  }
  if (schema.$ref) {
    // $ref yanındaki diğer anahtarlar 2020-12'de geçerlidir; ikisini de uygularız.
    walk(resolveRef(schema.$ref, root), data, dataPath, root, errors);
    const rest = { ...schema };
    delete rest.$ref;
    if (Object.keys(rest).length) walk(rest, data, dataPath, root, errors);
    return;
  }

  const t = TYPE_OF(data);

  // ── type ──────────────────────────────────────────────────────────────────
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((x) => typeMatches(data, x))) {
      errors.push({ path: dataPath, message: `tip ${types.join("|")} olmalı, gelen ${t}` });
      return; // yanlış tipte devam etmek gürültü üretir
    }
  }

  // ── enum / const ──────────────────────────────────────────────────────────
  if (Array.isArray(schema.enum) && !schema.enum.some((x) => deepEqual(x, data))) {
    errors.push({ path: dataPath, message: `değer şunlardan biri olmalı: ${schema.enum.map((x) => JSON.stringify(x)).join(", ")}` });
  }
  if ("const" in schema && !deepEqual(schema.const, data)) {
    errors.push({ path: dataPath, message: `değer ${JSON.stringify(schema.const)} olmalı` });
  }

  // ── mantıksal birleştiriciler ─────────────────────────────────────────────
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) walk(s, data, dataPath, root, errors);

  if (Array.isArray(schema.anyOf)) {
    const branch = schema.anyOf.map((s) => {
      const e = [];
      walk(s, data, dataPath, root, e);
      return e;
    });
    if (!branch.some((e) => e.length === 0)) {
      errors.push({ path: dataPath, message: `anyOf dallarının hiçbiri tutmadı (${branch.map((e) => e[0]?.message ?? "?").join(" | ")})` });
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const okCount = schema.oneOf.filter((s) => {
      const e = [];
      walk(s, data, dataPath, root, e);
      return e.length === 0;
    }).length;
    if (okCount !== 1) {
      errors.push({ path: dataPath, message: `oneOf tam olarak 1 dal tutmalı, ${okCount} tuttu` });
    }
  }

  if (schema.not !== undefined) {
    const e = [];
    walk(schema.not, data, dataPath, root, e);
    if (e.length === 0) errors.push({ path: dataPath, message: "not şeması tuttu — tutmamalıydı" });
  }

  if (schema.if !== undefined) {
    const e = [];
    walk(schema.if, data, dataPath, root, e);
    const chosen = e.length === 0 ? schema.then : schema.else;
    if (chosen !== undefined) walk(chosen, data, dataPath, root, errors);
  }

  // ── string ────────────────────────────────────────────────────────────────
  if (t === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push({ path: dataPath, message: `en az ${schema.minLength} karakter olmalı` });
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      errors.push({ path: dataPath, message: `en fazla ${schema.maxLength} karakter olmalı` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(data)) {
      errors.push({ path: dataPath, message: `"${schema.pattern}" desenine uymuyor` });
    }
  }

  // ── number ────────────────────────────────────────────────────────────────
  if (t === "number") {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push({ path: dataPath, message: `en az ${schema.minimum} olmalı` });
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push({ path: dataPath, message: `en fazla ${schema.maximum} olmalı` });
    }
    if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) {
      errors.push({ path: dataPath, message: `${schema.exclusiveMinimum} değerinden büyük olmalı` });
    }
    if (schema.exclusiveMaximum !== undefined && data >= schema.exclusiveMaximum) {
      errors.push({ path: dataPath, message: `${schema.exclusiveMaximum} değerinden küçük olmalı` });
    }
    if (schema.multipleOf !== undefined && Math.abs(data / schema.multipleOf - Math.round(data / schema.multipleOf)) > 1e-9) {
      errors.push({ path: dataPath, message: `${schema.multipleOf} katı olmalı` });
    }
  }

  // ── array ─────────────────────────────────────────────────────────────────
  if (t === "array") {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push({ path: dataPath, message: `en az ${schema.minItems} eleman olmalı` });
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      errors.push({ path: dataPath, message: `en fazla ${schema.maxItems} eleman olmalı` });
    }
    if (schema.uniqueItems === true) {
      const seen = [];
      for (const item of data) {
        if (seen.some((s) => deepEqual(s, item))) {
          errors.push({ path: dataPath, message: "elemanlar tekil olmalı" });
          break;
        }
        seen.push(item);
      }
    }
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    data.forEach((item, i) => {
      if (i < prefix.length) walk(prefix[i], item, pathJoin(dataPath, i), root, errors);
      else if (schema.items !== undefined) walk(schema.items, item, pathJoin(dataPath, i), root, errors);
    });
  }

  // ── object ────────────────────────────────────────────────────────────────
  if (t === "object") {
    const keys = Object.keys(data);
    for (const r of schema.required ?? []) {
      if (!(r in data)) errors.push({ path: pathJoin(dataPath, r), message: "zorunlu alan eksik" });
    }
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      errors.push({ path: dataPath, message: `en az ${schema.minProperties} alan olmalı` });
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      errors.push({ path: dataPath, message: `en fazla ${schema.maxProperties} alan olmalı` });
    }

    const props = schema.properties ?? {};
    const patterns = Object.entries(schema.patternProperties ?? {});
    for (const k of keys) {
      let matched = false;
      if (k in props) {
        matched = true;
        walk(props[k], data[k], pathJoin(dataPath, k), root, errors);
      }
      for (const [re, sub] of patterns) {
        if (new RegExp(re, "u").test(k)) {
          matched = true;
          walk(sub, data[k], pathJoin(dataPath, k), root, errors);
        }
      }
      if (!matched && schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) {
          errors.push({ path: pathJoin(dataPath, k), message: "tanımsız alan (additionalProperties: false)" });
        } else {
          walk(schema.additionalProperties, data[k], pathJoin(dataPath, k), root, errors);
        }
      }
      if (schema.propertyNames !== undefined) {
        walk(schema.propertyNames, k, pathJoin(dataPath, k) + " (anahtar)", root, errors);
      }
    }

    for (const [k, reqs] of Object.entries(schema.dependentRequired ?? {})) {
      if (k in data) {
        for (const r of reqs) {
          if (!(r in data)) {
            errors.push({ path: pathJoin(dataPath, r), message: `"${k}" varsa bu alan da zorunlu` });
          }
        }
      }
    }
  }
}

export default { validate };

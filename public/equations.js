
/* WebSolid - safe expression engine for global equations / parameter table.
   No eval, no Function(): a tiny recursive-descent parser that accepts
   numbers, identifiers, + - * / and parentheses. Shared by the browser
   (window.SolidEquations) and the server (require('./public/equations.js')). */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SolidEquations = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_EXPR = 80;
  var MAX_VARS = 20;
  var MAX_BINDINGS = 40;
  var NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

  /* ---- tokenizer ------------------------------------------------------- */
  function tokenize(src) {
    var out = [];
    var i = 0;
    while (i < src.length) {
      var c = src.charAt(i);
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      var d0 = src.charAt(i + 1);
      if ((c >= '0' && c <= '9') || (c === '.' && d0 >= '0' && d0 <= '9')) {
        var j = i, dot = false;
        while (j < src.length) {
          var d = src.charAt(j);
          if (d >= '0' && d <= '9') { j++; continue; }
          if (d === '.' && !dot) { dot = true; j++; continue; }
          break;
        }
        out.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        var k = i;
        while (k < src.length && /[A-Za-z0-9_]/.test(src.charAt(k))) k++;
        out.push({ t: 'id', v: src.slice(i, k) });
        i = k;
        continue;
      }
      if ('+-*/()'.indexOf(c) >= 0) { out.push({ t: 'op', v: c }); i++; continue; }
      return { ok: false, error: 'Unexpected character "' + c + '"' };
    }
    return { ok: true, tokens: out };
  }

  /* ---- parser (recursive descent, no eval) ------------------------------
     parse(src, resolve?) -> {ok, fn(env)}. During fn() every identifier is
     looked up in env, or handed to resolve(name) which may compute it lazily.
     A syntax fault (bad token, trailing garbage, empty parens) sets a flag so
     callers can distinguish "syntax error" from "undefined variable". */
  function parse(src, resolve) {
    src = String(src == null ? '' : src).trim();
    if (!src) return { ok: false, error: 'Empty expression' };
    if (src.length > MAX_EXPR) return { ok: false, error: 'Expression too long (max ' + MAX_EXPR + ')' };
    var tok = tokenize(src);
    if (!tok.ok) return tok;
    var ts = tok.tokens;
    var p = 0;
    var env = {};
    var syntaxBad = false;

    function peek() { return p < ts.length ? ts[p] : null; }

    function expr() {
      var left = term();
      if (left === null) return null;
      for (;;) {
        var t = peek();
        if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
          p++;
          var right = term();
          if (right === null) return null;
          left = t.v === '+' ? left + right : left - right;
        } else return left;
      }
    }

    function term() {
      var left = unary();
      if (left === null) return null;
      for (;;) {
        var t = peek();
        if (t && t.t === 'op' && (t.v === '*' || t.v === '/')) {
          p++;
          var right = unary();
          if (right === null) return null;
          if (t.v === '/') {
            if (right === 0) return null; /* division by zero */
            left = left / right;
          } else left = left * right;
        } else return left;
      }
    }

    function unary() {
      var t = peek();
      if (t && t.t === 'op' && (t.v === '-' || t.v === '+')) {
        p++;
        var v = unary();
        if (v === null) return null;
        return t.v === '-' ? -v : v;
      }
      return primary();
    }

    function primary() {
      var t = peek();
      if (!t) { syntaxBad = true; return null; }
      if (t.t === 'num') { p++; return t.v; }
      if (t.t === 'id') {
        p++;
        if (resolve) return resolve(t.v);
        if (!Object.prototype.hasOwnProperty.call(env, t.v)) return null;
        var val = env[t.v];
        if (typeof val !== 'number' || !isFinite(val)) return null;
        return val;
      }
      if (t.t === 'op' && t.v === '(') {
        p++;
        var inner = expr();
        if (inner === null) return null;
        var close = peek();
        if (!close || close.t !== 'op' || close.v !== ')') { syntaxBad = true; return null; }
        p++;
        return inner;
      }
      syntaxBad = true;
      return null;
    }

    function fn(e) {
      env = e || {};
      syntaxBad = false;
      p = 0;
      var v = expr();
      if (v === null) return null;
      if (p !== ts.length) { syntaxBad = true; return null; } /* trailing garbage */
      if (!isFinite(v)) return null;
      return v;
    }

    return { ok: true, fn: fn, isSyntaxBad: function () { return syntaxBad; } };
  }

  /* Validate the grammar of an expression alone (variables unknown = fine). */
  function checkSyntax(src) {
    var parsed = parse(src, function () { return 1; });
    if (!parsed.ok) return { ok: false, error: parsed.error };
    var v = parsed.fn({});
    if (v === null && parsed.isSyntaxBad()) return { ok: false, error: 'Invalid expression' };
    return { ok: true };
  }

  /* ---- model resolution --------------------------------------------------
     vars:    {name: number-or-expression}
     bindings: {"sketch.width": expression-or-number, ...}
     Returns {ok, vars, dims, errors}: resolved finite numbers for everything
     that resolved, plus one error line per failure (cycles, undefined names,
     bad syntax, invalid variable names). */
  function resolveAll(vars, bindings) {
    vars = vars && typeof vars === 'object' && !Array.isArray(vars) ? vars : {};
    bindings = bindings && typeof bindings === 'object' && !Array.isArray(bindings) ? bindings : {};
    var errors = [];
    var outVars = {};
    var state = {}; /* name -> 'ok' | 'cyc' | 'bad' */
    var stack = [];

    function resolve(name) {
      if (Object.prototype.hasOwnProperty.call(outVars, name)) return outVars[name];
      if (state[name] === 'cyc' || stack.indexOf(name) >= 0) { state[name] = 'cyc'; return null; }
      if (state[name] === 'bad') return null;
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return null;
      var raw = vars[name];
      if (typeof raw === 'number') {
        if (!isFinite(raw)) { state[name] = 'bad'; return null; }
        outVars[name] = raw;
        state[name] = 'ok';
        return raw;
      }
      if (typeof raw !== 'string') { state[name] = 'bad'; return null; }
      stack.push(name);
      var parsed = parse(raw, resolve);
      var v = parsed.ok ? parsed.fn(outVars) : null;
      stack.pop();
      if (v === null) { state[name] = stack.indexOf(name) >= 0 ? 'cyc' : 'bad'; return null; }
      outVars[name] = v;
      state[name] = 'ok';
      return v;
    }

    var names = Object.keys(vars).slice(0, MAX_VARS);
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (!NAME_RE.test(n)) { errors.push('Invalid variable name "' + n + '"'); continue; }
      if (resolve(n) === null) {
        if (state[n] === 'cyc') errors.push('Circular reference involving "' + n + '"');
        else errors.push('"' + n + '" could not be evaluated: ' + String(vars[n]));
      }
    }

    var outDims = {};
    var dimState = {}; /* path -> 'ok' | 'cyc' | 'bad' */
    var dimStack = [];

    /* Bindings may reference vars AND other bindings (e.g. chained
       dimensions). Resolved lazily with the same cycle guard as vars. */
    function resolveDim(path) {
      if (Object.prototype.hasOwnProperty.call(outDims, path)) return outDims[path];
      if (dimState[path] === 'cyc' || dimStack.indexOf(path) >= 0) { dimState[path] = 'cyc'; return null; }
      if (dimState[path] === 'bad') return null;
      if (!Object.prototype.hasOwnProperty.call(bindings, path)) return null;
      var raw2 = bindings[path];
      var parsed2 = parse(raw2, function (n) {
        var v = resolve(n);
        if (v !== null) return v;
        return resolveDim(n);
      });
      if (!parsed2.ok) { dimState[path] = 'bad'; return null; }
      dimStack.push(path);
      var val = parsed2.fn(outVars);
      dimStack.pop();
      if (val === null) { dimState[path] = dimStack.indexOf(path) >= 0 ? 'cyc' : 'bad'; return null; }
      outDims[path] = val;
      dimState[path] = 'ok';
      return val;
    }

    var paths = Object.keys(bindings).slice(0, MAX_BINDINGS);
    for (var b = 0; b < paths.length; b++) {
      var path = paths[b];
      var val = resolveDim(path);
      if (val === null) {
        if (dimState[path] === 'cyc') errors.push(path + ': circular reference among dimensions involving "' + path + '"');
        else errors.push(path + ': expression "' + bindings[path] + '" is invalid or references an undefined variable or dimension');
      }
    }

    return { ok: errors.length === 0, vars: outVars, dims: outDims, errors: errors };
  }

  function isValidName(n) { return NAME_RE.test(String(n)); }

  return {
    parse: parse,
    checkSyntax: checkSyntax,
    resolveAll: resolveAll,
    isValidName: isValidName,
    MAX_EXPR: MAX_EXPR,
    MAX_VARS: MAX_VARS,
    MAX_BINDINGS: MAX_BINDINGS
  };
});

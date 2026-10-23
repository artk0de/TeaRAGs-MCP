//! The collector: after analysis, one NDJSON row per call site of the local crate
//! (SPEC §3), with the drop rules of §3/§4.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use rustc_hir::{
    Expr, ExprKind, QPath,
    def::{DefKind, Res},
    intravisit::{self, Visitor},
};
use rustc_middle::ty::{self, Instance, TyCtxt, TypeVisitableExt, TypeckResults};
use rustc_span::{
    BytePos, ExpnKind, FileName, Span, SyntaxContext,
    def_id::{DefId, LOCAL_CRATE, LocalDefId},
    hygiene::{ExpnData, ExpnId, MacroKind},
};

use crate::Args;

pub(crate) struct Callbacks {
    args: Args,
    /// cargo's `-C extra-filename` (e.g. `-4fb7abc2c4382f18`): `<crate><suffix>` is the unit's
    /// rmeta stem, which is how the CLI maps cargo's compiler-artifact list onto unit files.
    unit_suffix: String,
}

impl Callbacks {
    pub(crate) fn new(args: Args, unit_suffix: String) -> Self {
        Callbacks { args, unit_suffix }
    }
}

/// Write `bytes` to `path` via a sibling temp file + rename, so a killed driver never
/// leaves a truncated unit file behind (the CLI's GC deletes stray `.tmp` files).
fn write_atomic(
    path: &Path,
    write: impl FnOnce(&mut dyn Write) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    {
        let mut f = std::io::BufWriter::new(fs::File::create(&tmp)?);
        write(&mut f)?;
        f.flush()?;
    }
    fs::rename(&tmp, path)
}

impl rustc_driver::Callbacks for Callbacks {
    fn after_analysis<'tcx>(
        &mut self,
        _compiler: &rustc_interface::interface::Compiler,
        tcx: TyCtxt<'tcx>,
    ) -> rustc_driver::Compilation {
        rustc_middle::ty::print::with_no_trimmed_paths!(self.collect(tcx))
    }
}

impl Callbacks {
    fn collect<'tcx>(&mut self, tcx: TyCtxt<'tcx>) -> rustc_driver::Compilation {
        let started = std::time::Instant::now();
        let mut rows: Vec<serde_json::Value> = Vec::new();
        let mut stats: HashMap<&'static str, u64> = HashMap::new();
        let mut lines = LineCache::default();
        let mut invocations = InvocationsSeen::default();
        let root = PathBuf::from(&self.args.project_root);
        for owner in tcx.hir_body_owners() {
            // `#[derive]` output carries the user's field/attribute spans, not an
            // expansion context: drop it by the enclosing impl's marker instead.
            let derived = tcx.opt_parent(owner.to_def_id()).is_some_and(|p| {
                matches!(tcx.def_kind(p), DefKind::Impl { .. }) && tcx.is_automatically_derived(p)
            });
            if derived {
                *stats.entry("drop.deriveBody").or_default() += 1;
                continue;
            }
            let tq = std::time::Instant::now();
            let typeck = tcx.typeck(owner);
            *stats.entry("us.typeckQuery").or_default() += tq.elapsed().as_micros() as u64;
            let body = tcx.hir_body_owned_by(owner);
            let mut v = CallVisitor {
                tcx,
                owner,
                typeck,
                root: &root,
                rows: &mut rows,
                stats: &mut stats,
                lines: &mut lines,
                invocations: &mut invocations,
            };
            let tv = std::time::Instant::now();
            v.visit_body(body);
            *stats.entry("us.visitBody").or_default() += tv.elapsed().as_micros() as u64;
        }
        let krate = tcx.crate_name(LOCAL_CRATE);
        let stable = tcx.stable_crate_id(LOCAL_CRATE);
        let path = Path::new(&self.args.units_dir).join(format!(
            "{}-{:016x}.ndjson",
            krate,
            stable.as_u64()
        ));
        write_atomic(&path, |f| {
            for r in &rows {
                writeln!(f, "{r}")?;
            }
            Ok(())
        })
        .expect("write unit ndjson");
        let mut stats_sorted: Vec<_> = stats.into_iter().collect();
        stats_sorted.sort();
        // Written after the rows: an `.ndjson` without its `.stats.json` is incomplete and GC'd.
        let stats_json = serde_json::json!({
            "crate": krate.to_string(),
            "unit": format!("{krate}{}", self.unit_suffix),
            "rows": rows.len(),
            "ms": started.elapsed().as_millis() as u64,
            "stats": stats_sorted,
        });
        write_atomic(&path.with_extension("stats.json"), |f| {
            write!(f, "{stats_json}")
        })
        .expect("write unit stats");
        rustc_driver::Compilation::Continue
    }
}

#[derive(Default)]
struct LineCache {
    files: HashMap<PathBuf, Option<Vec<String>>>,
    canon: HashMap<PathBuf, PathBuf>,
}

impl LineCache {
    /// utf16 column of the `char_col`-th char of 1-based `line`.
    fn utf16_col(&mut self, file: &Path, line: usize, char_col: usize) -> Option<usize> {
        let entry = self.files.entry(file.to_path_buf()).or_insert_with(|| {
            fs::read_to_string(file)
                .ok()
                .map(|t| t.split('\n').map(str::to_owned).collect())
        });
        let text = entry.as_ref()?.get(line.checked_sub(1)?)?;
        Some(text.chars().take(char_col).map(char::len_utf16).sum())
    }
}

struct CallVisitor<'a, 'tcx> {
    tcx: TyCtxt<'tcx>,
    owner: LocalDefId,
    typeck: &'tcx TypeckResults<'tcx>,
    root: &'a Path,
    rows: &'a mut Vec<serde_json::Value>,
    stats: &'a mut HashMap<&'static str, u64>,
    lines: &'a mut LineCache,
    invocations: &'a mut InvocationsSeen,
}

/// Per crate: the syntax contexts already walked to their outermost expansion, and the
/// user-written invocations already emitted — one row per invocation, however many
/// expressions its expansion produced.
#[derive(Default)]
struct InvocationsSeen {
    contexts: HashSet<SyntaxContext>,
    expansions: HashSet<ExpnId>,
}

/// The outermost expansion of `span`'s context: the one whose call site is user text.
fn outermost_expansion(span: Span) -> Option<(ExpnId, ExpnData)> {
    let mut ctxt = span.ctxt();
    while !ctxt.is_root() {
        let expn = ctxt.outer_expn();
        let expn_data = expn.expn_data();
        if !expn_data.call_site.from_expansion() {
            return Some((expn, expn_data));
        }
        ctxt = expn_data.call_site.ctxt();
    }
    None
}

/// Byte offset of the macro NAME in the invocation text: past the path's last `::`
/// (`std::write!(..)` → `write`), before the `!`.
fn macro_name_offset(invocation: &str) -> Option<usize> {
    let bang = invocation.find('!')?;
    let path = &invocation[..bang];
    let name_start = path.rfind("::").map_or(0, |i| i + 2);
    let leading_ws = path[name_start..].len() - path[name_start..].trim_start().len();
    Some(name_start + leading_ws)
}

struct Pos {
    rel_path: String,
    line: usize,
    col_utf16: usize,
    in_root: bool,
}

impl<'a, 'tcx> CallVisitor<'a, 'tcx> {
    fn tick(&mut self, k: &'static str, t: std::time::Instant) {
        *self.stats.entry(k).or_default() += t.elapsed().as_micros() as u64;
    }

    fn bump(&mut self, k: &'static str) {
        *self.stats.entry(k).or_default() += 1;
    }

    fn pos(&mut self, span: Span) -> Option<Pos> {
        let sm = self.tcx.sess.source_map();
        let loc = sm.lookup_char_pos(span.lo());
        let local = match &loc.file.name {
            FileName::Real(real) => real.local_path()?.to_path_buf(),
            _ => return None,
        };
        let abs = match self.lines.canon.get(&local) {
            Some(a) => a.clone(),
            None => {
                let joined = if local.is_absolute() {
                    local.clone()
                } else {
                    std::env::current_dir().ok()?.join(&local)
                };
                let a = joined.canonicalize().unwrap_or(joined);
                self.lines.canon.insert(local, a.clone());
                a
            }
        };
        let col_utf16 = self.lines.utf16_col(&abs, loc.line, loc.col.0)?;
        let (rel_path, in_root) = match abs.strip_prefix(self.root) {
            Ok(rel) => (rel.to_string_lossy().into_owned(), true),
            Err(_) => (abs.to_string_lossy().into_owned(), false),
        };
        Some(Pos {
            rel_path,
            line: loc.line,
            col_utf16,
            in_root,
        })
    }

    fn def_kind_name(&self, def_id: DefId) -> &'static str {
        match self.tcx.def_kind(def_id) {
            DefKind::Fn => "fn",
            DefKind::AssocFn => "assocFn",
            DefKind::Ctor(..) => "ctor",
            DefKind::Closure => "closure",
            DefKind::Static { .. } => "static",
            DefKind::Const { .. } | DefKind::AssocConst { .. } => "const",
            _ => "other",
        }
    }

    /// The row position of a callee name token: `(origin, macro, pos)`, or `None` (with the
    /// drop counted) for desugarings, foreign expansions and callers outside the root.
    fn call_site(&mut self, name_span: Span) -> Option<(&'static str, Option<String>, Pos)> {
        // Macro handling: a name token the user wrote (macro ARGUMENT) keeps a root
        // context; a name token the macro body produced is from_expansion.
        let (origin, macro_name, site) = if name_span.from_expansion() {
            let data = name_span.ctxt().outer_expn_data();
            match data.kind {
                ExpnKind::Desugaring(_) => {
                    self.bump("drop.desugaring");
                    return None;
                }
                ExpnKind::Macro(_, name) => {
                    ("macro", Some(name.to_string()), name_span.source_callsite())
                }
                _ => {
                    self.bump("drop.otherExpansion");
                    return None;
                }
            }
        } else {
            ("source", None, name_span)
        };
        let t0 = std::time::Instant::now();
        let Some(pos) = self.pos(site) else {
            self.bump("drop.noPosition");
            return None;
        };
        if !pos.in_root {
            self.bump("drop.callerOutsideRoot");
            return None;
        }
        self.tick("us.sitePos", t0);
        Some((origin, macro_name, pos))
    }

    fn emit(
        &mut self,
        call_kind: &'static str,
        name_span: Span,
        def_id: DefId,
        generic_args: ty::GenericArgsRef<'tcx>,
    ) {
        let tcx = self.tcx;
        let Some((origin, macro_name, pos)) = self.call_site(name_span) else {
            return;
        };
        let t1 = std::time::Instant::now();
        let (trait_path, impl_self) = (
            tcx.trait_of_assoc(def_id).map(|t| tcx.def_path_str(t)),
            tcx.impl_of_assoc(def_id).map(|i| {
                tcx.type_of(i)
                    .instantiate_identity()
                    .skip_normalization()
                    .to_string()
            }),
        );
        // Monomorphic dispatch: a trait method whose receiver type is concrete
        // resolves to the impl item the call actually runs.
        let mut resolved: Option<DefId> = None;
        if tcx.trait_of_assoc(def_id).is_some()
            && !generic_args.has_infer()
            && !generic_args.references_error()
        {
            let typing_env = ty::TypingEnv::post_analysis(tcx, self.owner.to_def_id());
            let erased_args = tcx.erase_and_anonymize_regions(generic_args);
            if let Ok(Some(inst)) = Instance::try_resolve(tcx, typing_env, def_id, erased_args) {
                if inst.def_id() != def_id {
                    resolved = Some(inst.def_id());
                    self.bump("trait.resolvedToImpl");
                } else {
                    self.bump("trait.unresolved");
                }
            } else {
                self.bump("trait.resolveError");
            }
        }
        self.tick("us.traitAndResolve", t1);
        let t2 = std::time::Instant::now();
        let target = resolved.unwrap_or(def_id);
        let def_pos = tcx
            .def_ident_span(target)
            .or_else(|| Some(tcx.def_span(target)))
            .and_then(|s| self.pos(s));
        self.tick("us.defPos", t2);
        let t3 = std::time::Instant::now();
        let in_project = def_pos.as_ref().map_or(false, |p| p.in_root);
        self.bump(if in_project {
            "callee.inProject"
        } else {
            "callee.external"
        });
        self.bump(if origin == "macro" {
            "origin.macro"
        } else {
            "origin.source"
        });
        let row = serde_json::json!({
            "relPath": pos.rel_path,
            "line": pos.line,
            "col": pos.col_utf16,
            "origin": origin,
            "macro": macro_name,
            "callKind": call_kind,
            "callee": tcx.def_path_str(def_id),
            "calleeCrate": tcx.crate_name(def_id.krate).to_string(),
            "defKind": self.def_kind_name(def_id),
            "traitPath": trait_path,
            "implSelfType": impl_self,
            "resolvedImpl": resolved.map(|r| tcx.def_path_str(r)),
            "implIsDerived": resolved
                .and_then(|r| tcx.impl_of_assoc(r))
                .is_some_and(|i| tcx.is_automatically_derived(i)),
            "inProject": in_project,
            "defRelPath": def_pos.as_ref().filter(|p| p.in_root).map(|p| p.rel_path.clone()),
            "defLine": def_pos.as_ref().filter(|p| p.in_root).map(|p| p.line),
        });
        self.tick("us.rowStrings", t3);
        self.rows.push(row);
    }

    /// A call whose callee is a local binding, a param or a field (RESIDUAL R4): the callee's
    /// TYPE decides the row. A fn item is a real target (`callKind: "local"`); a closure,
    /// fn pointer or Fn-bound param / trait object has no definition to name, so the row
    /// carries the binding name and the indirection kind only.
    fn emit_indirect(&mut self, callee: &'tcx Expr<'tcx>, name_span: Span) {
        // The ADJUSTED type: an overloaded call autoderefs the callee (`Arc<dyn Fn>` → `&dyn Fn`).
        let mut callee_ty = self.typeck.expr_ty_adjusted(callee);
        loop {
            callee_ty = match callee_ty.kind() {
                ty::Ref(_, inner, _) => *inner,
                _ if callee_ty.is_box() => callee_ty.expect_boxed_ty(),
                _ => break,
            };
        }
        let def_kind = match *callee_ty.kind() {
            ty::FnDef(def_id, generic_args) => {
                return self.emit("local", name_span, def_id, generic_args);
            }
            ty::Closure(..) => "closure",
            ty::FnPtr(..) => "fnPointer",
            ty::Dynamic(..) | ty::Param(_) | ty::Alias(..) => "fnParam",
            _ => {
                self.bump("drop.indirectCalleeType");
                return;
            }
        };
        let Some((origin, macro_name, pos)) = self.call_site(name_span) else {
            return;
        };
        let name = self
            .tcx
            .sess
            .source_map()
            .span_to_snippet(name_span)
            .unwrap_or_default();
        self.bump("callee.indirect");
        self.rows.push(serde_json::json!({
            "relPath": pos.rel_path,
            "line": pos.line,
            "col": pos.col_utf16,
            "origin": origin,
            "macro": macro_name,
            "callKind": "local",
            "callee": name,
            "calleeCrate": null,
            "defKind": def_kind,
            "traitPath": null,
            "implSelfType": null,
            "resolvedImpl": null,
            "implIsDerived": false,
            "inProject": false,
            "defRelPath": null,
            "defLine": null,
        }));
    }

    /// The `macroInvocation` row of the user-written bang-macro invocation `span`'s
    /// expansion comes from, once per invocation, at the macro NAME token. Invocations
    /// nested inside an expansion (`write!` → `format_args!`) are not user sites.
    fn note_invocation(&mut self, span: Span) {
        if !span.from_expansion() || !self.invocations.contexts.insert(span.ctxt()) {
            return;
        }
        let Some((expn, expn_data)) = outermost_expansion(span) else {
            return;
        };
        if !self.invocations.expansions.insert(expn) {
            return;
        }
        let ExpnKind::Macro(MacroKind::Bang, name) = expn_data.kind else {
            return;
        };
        let tcx = self.tcx;
        let Some(def_id) = expn_data.macro_def_id else {
            self.bump("drop.macroNoDef");
            return;
        };
        let call_site = expn_data.call_site;
        let name_span = tcx
            .sess
            .source_map()
            .span_to_snippet(call_site)
            .ok()
            .and_then(|text| macro_name_offset(&text))
            .map(|offset| call_site.with_lo(call_site.lo() + BytePos(offset as u32)));
        let Some(pos) = name_span.and_then(|s| self.pos(s)) else {
            self.bump("drop.macroNoPosition");
            return;
        };
        if !pos.in_root {
            self.bump("drop.callerOutsideRoot");
            return;
        }
        let def_pos = tcx
            .def_ident_span(def_id)
            .or_else(|| Some(tcx.def_span(def_id)))
            .and_then(|s| self.pos(s))
            .filter(|p| p.in_root);
        self.bump("origin.macroInvocation");
        self.rows.push(serde_json::json!({
            "relPath": pos.rel_path,
            "line": pos.line,
            "col": pos.col_utf16,
            "origin": "macroInvocation",
            // The expansion names the invoked PATH (`fx_core::my_log`); the row names the macro.
            "macro": name.as_str().rsplit("::").next().unwrap_or_default(),
            "macroDefPath": tcx.def_path_str(def_id),
            "calleeCrate": tcx.crate_name(def_id.krate).to_string(),
            "inProject": def_pos.is_some(),
            "defRelPath": def_pos.as_ref().map(|p| p.rel_path.clone()),
            "defLine": def_pos.as_ref().map(|p| p.line),
        }));
    }
}

impl<'a, 'tcx> Visitor<'tcx> for CallVisitor<'a, 'tcx> {
    fn visit_expr(&mut self, expr: &'tcx Expr<'tcx>) {
        self.note_invocation(expr.span);
        match expr.kind {
            ExprKind::MethodCall(segment, ..) => {
                match self.typeck.type_dependent_def_id(expr.hir_id) {
                    Some(def_id) => self.emit(
                        "method",
                        segment.ident.span,
                        def_id,
                        self.typeck.node_args(expr.hir_id),
                    ),
                    None => self.bump("drop.methodUnresolved"),
                }
            }
            ExprKind::Call(callee, _) => {
                if let ExprKind::Path(ref qpath) = callee.kind {
                    let name_span = match qpath {
                        QPath::Resolved(_, path) => path.segments.last().map(|s| s.ident.span),
                        QPath::TypeRelative(_, seg) => Some(seg.ident.span),
                    };
                    match (self.typeck.qpath_res(qpath, callee.hir_id), name_span) {
                        (Res::Def(_, def_id), Some(span)) => {
                            self.emit("path", span, def_id, self.typeck.node_args(callee.hir_id))
                        }
                        (Res::Local(_), Some(span)) => self.emit_indirect(callee, span),
                        (_, None) => self.bump("drop.langItemPath"),
                        _ => self.bump("drop.pathOther"),
                    }
                } else if let ExprKind::Field(_, field) = callee.kind {
                    self.emit_indirect(callee, field.span);
                } else {
                    self.bump("drop.nonPathCallee");
                }
            }
            _ => {}
        }
        intravisit::walk_expr(self, expr);
    }
}

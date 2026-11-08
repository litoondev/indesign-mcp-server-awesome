var doc = __resolveDocument();
function sp(st) { var n = st.name; var p = st.parent; while (p && p.constructor.name === 'ParagraphStyleGroup') { n = p.name + '/' + n; p = p.parent; } return n; }
var out = { name: doc.name, full: String(doc.fullName.fsName), pages: [], masters: [], sections: [], swatches: [], stories: {} };
for (var m = 0; m < doc.masterSpreads.length; m++) out.masters.push(doc.masterSpreads[m].name);
for (var s = 0; s < doc.sections.length; s++) { var se = doc.sections[s]; out.sections.push({ start: se.pageStart.documentOffset, prefix: se.sectionPrefix, marker: se.marker, style: String(se.pageNumberStyle), cont: se.continueNumbering, startNo: se.pageNumberStart }); }
var sw = doc.swatches; for (var w = 0; w < sw.length; w++) out.swatches.push(sw[w].name);
var storyIds = {};
for (var i = 0; i < doc.pages.length; i++) {
  var pg = doc.pages[i];
  var pd = { i: i, name: pg.name, side: String(pg.side), master: pg.appliedMaster ? pg.appliedMaster.name : null, bounds: pg.bounds, items: [] };
  if (i >= 11) {
    var els = pg.allPageItems;
    for (var k = 0; k < els.length; k++) {
      var it = els[k]; var o = { id: it.id, type: it.constructor.name, parent: it.parent.constructor.name, b: it.geometricBounds, name: it.name };
      try { o.fill = it.fillColor.name; } catch (e) {}
      if (o.type === 'TextFrame') { o.story = it.parentStory.id; o.prev = it.previousTextFrame ? it.previousTextFrame.id : null; o.next = it.nextTextFrame ? it.nextTextFrame.id : null; o.text = String(it.contents).substr(0, 60); o.chars = it.characters.length; o.overflows = it.overflows; storyIds[it.parentStory.id] = 1; }
      pd.items.push(o);
    }
  }
  out.pages.push(pd);
}
for (var sid in storyIds) {
  var st = doc.stories.itemByID(Number(sid));
  if (!st.isValid) continue;
  var paras = st.paragraphs.everyItem().getElements();
  var ps = [];
  for (var q = 0; q < paras.length && q < 80; q++) {
    var p = paras[q]; var t = String(p.contents); var runs = [];
    var tsr = p.textStyleRanges.everyItem().getElements();
    for (var r = 0; r < tsr.length; r++) { var fs = '', fc = ''; try { fs = tsr[r].appliedFont.fontStyleName; } catch (e) {} try { fc = tsr[r].fillColor.name; } catch (e) {} runs.push(fs + '|' + fc + '|' + String(tsr[r].contents).length); }
    var fr = null; try { fr = p.parentTextFrames[0].id; } catch (e) {}
    ps.push({ q: q, style: sp(p.appliedParagraphStyle), styleId: p.appliedParagraphStyle.id, frame: fr, anch: p.allPageItems.length, tables: p.tables.length, size: p.pointSize, text: t.substr(0, 90), len: t.length, runs: runs });
  }
  var tc = st.textContainers, frs = []; for (var z = 0; z < tc.length; z++) frs.push(tc[z].id);
  out.stories[sid] = { paraCount: st.paragraphs.length, len: st.characters.length, overflows: st.overflows, frames: frs, tables: st.tables.length, anchored: st.allPageItems.length, paras: ps };
}
__ok(out);

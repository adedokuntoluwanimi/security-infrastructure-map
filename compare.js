// compare.js
// Adds UI wiring for comparison, search, chart and PDF generation.
// Designed to work client-side with your QGIS2Web-generated data layers.
//
// Assumptions (safe-guards included):
// - Risk polygon data is exposed via a global json object from RiskIndex_1.js.
//   Typical variable name: json_RiskIndex_1 (but code will scan for a GeoJSON object).
// - Facility points available as json_police_4, json_army_3, json_checkpoints_5 if present.
// - Field names for state/LGA/ward are guessed from common variants and auto-detected at runtime.

(function(){
  // Utility: find GeoJSON-like global objects
  function findGeoJsonCandidate(prefix){
    for (const key in window) {
      if (!window.hasOwnProperty(key)) continue;
      if (!key.toLowerCase().includes(prefix.toLowerCase())) continue;
      const v = window[key];
      if (v && v.type && v.type === 'FeatureCollection') return v;
      if (v && v.features && Array.isArray(v.features)) return v;
    }
    return null;
  }

  const riskGeo = findGeoJsonCandidate('RiskIndex') || findGeoJsonCandidate('risk');
  const policeGeo = findGeoJsonCandidate('police') || findGeoJsonCandidate('police_4');
  const armyGeo = findGeoJsonCandidate('army') || findGeoJsonCandidate('army_3');
  const checkpointsGeo = findGeoJsonCandidate('checkpoints') || findGeoJsonCandidate('checkpoint');

  // fields detection for name properties (state, lga, ward)
  function detectFields(sampleFeature){
    const props = sampleFeature && sampleFeature.properties ? Object.keys(sampleFeature.properties) : [];
    const l = props.map(p => p.toLowerCase());
    function findOne(candidates){
      for (const c of candidates){
        const i = l.indexOf(c.toLowerCase());
        if (i>=0) return props[i];
      }
      return null;
    }
    return {
      state: findOne(['STATE','STATE_NAME','state','state_name','st_name']),
      lga: findOne(['LGA','LGA_NAME','lga','lga_name','local_govt','local_gov']),
      ward: findOne(['WARD','WARD_NAME','ward','ward_name','ward_no','wardid']),
      riskField: findOne(['final_risk_score','risk_score','risk','score','final_score','risk_index','risk_index_value'])
    };
  }

  const sample = (riskGeo && riskGeo.features && riskGeo.features[0]) || null;
  const fields = detectFields(sample || {});
  // If we couldn't detect anything, fallback labels to generic NAME
  if(!fields.state) fields.state = 'STATE';
  if(!fields.lga) fields.lga = 'LGA';
  if(!fields.ward) fields.ward = 'WARD';
  if(!fields.riskField) fields.riskField = 'risk_score';

  // DOM references
  const levelSel = document.getElementById('level');
  const regionA = document.getElementById('regionA');
  const regionB = document.getElementById('regionB');
  const btnCompare = document.getElementById('btnCompare');
  const btnResetView = document.getElementById('btnResetView');
  const popup = document.getElementById('download-popup');
  const closePopup = document.getElementById('close-popup');
  const btnClose = document.getElementById('btnClose');
  const chartCanvas = document.getElementById('comparisonChart').getContext('2d');
  const btnDownloadPdf = document.getElementById('btnDownloadPdf');
  const searchInput = document.getElementById('search-input');
  const btnSearch = document.getElementById('btnSearch');

  // app map and highlight access
  const map = window.APP && window.APP.map;
  const view = window.APP && window.APP.view;
  const highlightSource = window.APP && window.APP.highlightSource;

  // Helper: get unique names for a level
  function uniqueNamesForLevel(level){
    if(!riskGeo || !riskGeo.features) return [];
    const fn = (feat) => {
      const p = feat.properties || {};
      if(level === 'state') return p[fields.state] || p.STATE || p.State || p.state || null;
      if(level === 'lga') return p[fields.lga] || p.LGA || p.lga || null;
      if(level === 'ward') return p[fields.ward] || p.WARD || p.ward || null;
      return null;
    };
    const set = new Set();
    for(const f of riskGeo.features){
      const v = fn(f);
      if(v) set.add(String(v).trim());
    }
    return Array.from(set).sort((a,b)=>a.localeCompare(b));
  }

  // populate dropdowns when level changes
  function populateRegions(){
    const lvl = levelSel.value;
    const names = uniqueNamesForLevel(lvl);
    function fill(sel){
      sel.innerHTML = '<option>-- select --</option>';
      for(const n of names){
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        sel.appendChild(opt);
      }
    }
    fill(regionA); fill(regionB);
  }
  levelSel.addEventListener('change', populateRegions);
  populateRegions();

  // spatial checks: feature contains coordinate
  // we will use ol.geom.Polygon if available in riskGeo (coordinate arrays)
  function featureContainsPoint(feature, lonLat){
    // feature can be GeoJSON feature with geometry coordinates array
    if(!feature || !feature.geometry) return false;
    const geom = feature.geometry;
    // convert lonLat to [lon,lat]
    const pt = lonLat;
    // Support polygons and multipolygons
    const rings = (geom.type==='MultiPolygon') ? geom.coordinates.flat() : (geom.type==='Polygon' ? geom.coordinates : null);
    if(!rings) return false;
    // Use ray-casting for point-in-polygon (works for simple polygons)
    for(const ring of rings){
      if(pointInRing(pt, ring)) return true;
    }
    return false;
  }

  function pointInRing(point, ring){
    // point [lon,lat], ring: [[lon,lat],...]
    let x = point[0], y = point[1];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      let xi = ring[i][0], yi = ring[i][1];
      let xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 0.0) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // convert ol extent to GeoJSON-like bbox to feature intersection - helper for highlighting
  function getFeaturesByName(level, nameValue){
    if(!riskGeo || !riskGeo.features) return [];
    const out = [];
    for(const f of riskGeo.features){
      const p = f.properties || {};
      const v = (level==='state') ? (p[fields.state] || p.STATE || p.state) :
                (level==='lga') ? (p[fields.lga] || p.LGA || p.lga) :
                (p[fields.ward] || p.WARD || p.ward);
      if(!v) continue;
      if(String(v).trim().toLowerCase() === String(nameValue).trim().toLowerCase()){
        out.push(f);
      }
    }
    return out;
  }

  // Count facilities within a polygon (GeoJSON feature)
  function countFacilitiesInFeature(feature){
    const counts = {police:0, army:0, checkpoints:0};
    // build bounding check for speed
    const coords = feature.geometry && feature.geometry.coordinates ? feature.geometry.coordinates.flat(2) : [];
    // fallback: test every point by point-in-polygon
    if(policeGeo && policeGeo.features){
      for(const p of policeGeo.features){
        const pt = p.geometry && p.geometry.coordinates ? p.geometry.coordinates : null;
        if(pt && featureContainsPoint(feature, pt)) counts.police++;
      }
    }
    if(armyGeo && armyGeo.features){
      for(const p of armyGeo.features){
        const pt = p.geometry && p.geometry.coordinates ? p.geometry.coordinates : null;
        if(pt && featureContainsPoint(feature, pt)) counts.army++;
      }
    }
    if(checkpointsGeo && checkpointsGeo.features){
      for(const p of checkpointsGeo.features){
        const pt = p.geometry && p.geometry.coordinates ? p.geometry.coordinates : null;
        if(pt && featureContainsPoint(feature, pt)) counts.checkpoints++;
      }
    }
    return counts;
  }

  // create simple risk category from risk numeric field if available
  function riskCategoryFromValue(v){
    if(v === null || v === undefined || isNaN(Number(v))) return 'Unknown';
    const n = Number(v);
    if(n <= 33) return 'Low';
    if(n <= 66) return 'Medium';
    return 'High';
  }

  // Highlight features on map (renders GeoJSON to ol.Feature)
  function highlightGeoJsonFeatures(features, color='#ff6600'){
    highlightSource.clear();
    for(const f of features){
      try {
        const geom = f.geometry;
        const coords = geom.coordinates;
        // convert each polygon ring coordinates to ol.geom.Polygon with projection conversion
        if(geom.type === 'Polygon'){
          const rings = coords.map(r => r.map(c => ol.proj.fromLonLat([c[0], c[1]])));
          const poly = new ol.Feature(new ol.geom.Polygon(rings));
          poly.setStyle(new ol.style.Style({
            stroke: new ol.style.Stroke({color, width:3}),
            fill: new ol.style.Fill({color: color === '#ff6600' ? 'rgba(255,102,0,0.12)' : 'rgba(0,128,255,0.08)'})
          }));
          highlightSource.addFeature(poly);
        } else if(geom.type === 'MultiPolygon'){
          for(const polyCoords of coords){
            const rings = polyCoords.map(r => r.map(c => ol.proj.fromLonLat([c[0], c[1]])));
            const poly = new ol.Feature(new ol.geom.Polygon(rings));
            poly.setStyle(new ol.style.Style({
              stroke: new ol.style.Stroke({color, width:3}),
              fill: new ol.style.Fill({color: color === '#ff6600' ? 'rgba(255,102,0,0.12)' : 'rgba(0,128,255,0.08)'})
            }));
            highlightSource.addFeature(poly);
          }
        }
      } catch(e){
        console.warn('Highlight geometry error', e);
      }
    }
  }

  // Fit map to show features
  function fitToFeatures(features){
    try {
      const allCoords = [];
      for(const f of features){
        const geom = f.geometry;
        if(!geom) continue;
        const flat = (geom.type==='MultiPolygon') ? geom.coordinates.flat(2) : (geom.type==='Polygon' ? geom.coordinates.flat(2) : []);
        for(const c of flat){
          allCoords.push(ol.proj.fromLonLat([c[0], c[1]]));
        }
      }
      if(allCoords.length===0) return;
      const extent = ol.extent.createEmpty();
      for(const c of allCoords) ol.extent.extend(extent, [c[0], c[1], c[0], c[1]]);
      view.fit(extent, {padding:[50,50,50,50], maxZoom:12});
    } catch(e){
      console.warn('fitToFeatures error', e);
    }
  }

  // Build comparison dataset and render chart
  let currentChart = null;
  function renderComparison(regionNameA, featuresA, regionNameB, featuresB){
    // Aggregate counts and risk categories for each region (if multiple features per selection we sum)
    const aggA = {police:0, army:0, checkpoints:0, riskValues:[]};
    const aggB = {police:0, army:0, checkpoints:0, riskValues:[]};

    for(const f of featuresA){
      const counts = countFacilitiesInFeature(f);
      aggA.police += counts.police;
      aggA.army += counts.army;
      aggA.checkpoints += counts.checkpoints;
      const rv = f.properties && f.properties[fields.riskField] !== undefined ? Number(f.properties[fields.riskField]) : null;
      if(rv !== null && !isNaN(rv)) aggA.riskValues.push(rv);
    }
    for(const f of featuresB){
      const counts = countFacilitiesInFeature(f);
      aggB.police += counts.police;
      aggB.army += counts.army;
      aggB.checkpoints += counts.checkpoints;
      const rv = f.properties && f.properties[fields.riskField] !== undefined ? Number(f.properties[fields.riskField]) : null;
      if(rv !== null && !isNaN(rv)) aggB.riskValues.push(rv);
    }

    // average risk values if available
    const avgA = aggA.riskValues.length ? (aggA.riskValues.reduce((s,x)=>s+x,0)/aggA.riskValues.length) : null;
    const avgB = aggB.riskValues.length ? (aggB.riskValues.reduce((s,x)=>s+x,0)/aggB.riskValues.length) : null;

    const labels = ['Police','Army','Checkpoints'];
    const dataA = [aggA.police, aggA.army, aggA.checkpoints];
    const dataB = [aggB.police, aggB.army, aggB.checkpoints];

    // destroy previous chart
    if(currentChart) currentChart.destroy();

    currentChart = new Chart(chartCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: regionNameA, data: dataA, backgroundColor: 'rgba(54,162,235,0.6)' },
          { label: regionNameB, data: dataB, backgroundColor: 'rgba(255,99,132,0.6)' },
          // overlay risk as line (scale adjusted to a small multiplier)
          { label: 'Risk (avg)', data: [(avgA||0),(avgB||0)], type: 'line', yAxisID:'riskAxis', tension:0.2, borderWidth:2, pointRadius:4, backgroundColor:'rgba(0,0,0,0.1)'}
        ]
      },
      options: {
        responsive:true,
        interaction:{mode:'index',intersect:false},
        scales: {
          y: { beginAtZero:true, position:'left', title:{display:true,text:'Facility count'} },
          riskAxis: { type:'linear', position:'right', beginAtZero:true, display:true, title:{display:true,text:'Risk (avg)'} }
        }
      }
    });

    // show popup
    popup.style.display = 'block';
    document.getElementById('modal-title').textContent = `${regionNameA} vs ${regionNameB}`;
    // highlight and fit
    highlightGeoJsonFeatures(featuresA, '#2a9d8f');
    highlightGeoJsonFeatures(featuresB, '#e76f51');
    fitToFeatures([...featuresA, ...featuresB]);

    // prepare data to be used by PDF generator
    popup.currentData = {regionNameA, regionNameB, aggA, aggB, avgA, avgB, featuresA, featuresB};
  }

  // create narrative for a single region (no numbers)
  function createRegionNarrative(regionName, agg, avgRisk){
    const cat = riskCategoryFromValue(avgRisk);
    const parts = [];
    parts.push(`Regional Interpretation for ${regionName}.`);
    parts.push(`This area falls within the ${cat} risk category.`);
    // police presence
    if(agg.police > 3) parts.push('Police coverage is comparatively strong, with multiple stations providing response capacity across the area.');
    else if(agg.police > 0) parts.push('Some police presence exists, but it is uneven across the area.');
    else parts.push('Police stations are largely absent inside the area, which may limit immediate response.');

    // army
    if(agg.army > 1) parts.push('Military installations provide additional stabilizing influence in parts of the region.');
    else parts.push('Military presence in this region is limited.');

    // checkpoints
    if(agg.checkpoints > 4) parts.push('Checkpoints are frequent along main routes, improving movement monitoring.');
    else if(agg.checkpoints > 0) parts.push('Checkpoints are present but sparse across the internal network.');
    else parts.push('There are few or no checkpoints within the region.');

    parts.push('Land use patterns and local activities in the area contribute to the overall risk profile and should be considered alongside facility distribution.');

    return parts.join(' ');
  }

  // create comparative narrative
  function createComparativeNarrative(nameA, aggA, avgA, nameB, aggB, avgB){
    const catA = riskCategoryFromValue(avgA);
    const catB = riskCategoryFromValue(avgB);
    const parts = [];
    parts.push(`Comparative Interpretation of ${nameA} and ${nameB}.`);
    parts.push(`${nameA} is in the ${catA} category, while ${nameB} is in the ${catB} category.`);
    // contrast police
    if(aggA.police > aggB.police) parts.push(`${nameA} shows stronger police coverage compared to ${nameB}.`);
    else if(aggB.police > aggA.police) parts.push(`${nameB} shows stronger police coverage compared to ${nameA}.`);
    else parts.push(`Police coverage is similar between both regions.`);

    // checkpoints
    if(aggA.checkpoints > aggB.checkpoints) parts.push(`${nameA} has more checkpoints, which improves monitoring.`);
    else if(aggB.checkpoints > aggA.checkpoints) parts.push(`${nameB} has more checkpoints.`);
    else parts.push(`Checkpoint presence is comparable across both areas.`);

    parts.push('Taken together, facility distribution and land-use patterns explain the relative difference between the regions.');
    return parts.join(' ');
  }

  // PDF generation using jsPDF + html2canvas
  async function generatePdfForComparison(data){
    // data: popup.currentData
    if(!data) return;
    const {regionNameA, regionNameB, aggA, aggB, avgA, avgB} = data;
    // capture chart as image
    const chartCanvasEl = document.getElementById('comparisonChart');
    const chartDataUrl = chartCanvasEl.toDataURL('image/png',1.0);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({orientation:'portrait', unit:'pt', format:'a4'});

    const margin = 40;
    const pageWidth = doc.internal.pageSize.getWidth();

    // Header: logo left
    try{
      const logo = new Image();
      logo.src = 'images/logo.jpg';
      await new Promise(r => { logo.onload=r; logo.onerror=r; });
      doc.addImage(logo, 'JPEG', margin, 20, 60, 60);
    } catch(e){
      // ignore if missing
    }

    // Title centered
    doc.setFontSize(18);
    doc.setFont('helvetica','bold');
    doc.text('GEOINFOTECH', pageWidth/2, 40, {align:'center'});
    doc.setFontSize(14);
    doc.setFont('helvetica','bold');
    doc.text('Security Infrastructure Report', pageWidth/2, 62, {align:'center'});

    // region meta
    doc.setFontSize(10);
    doc.setFont('helvetica','normal');
    doc.text(`Comparison: ${regionNameA}  vs  ${regionNameB}`, margin, 100);
    doc.text(`Date: ${new Date().toLocaleString()}`, margin, 116);

    // chart
    doc.addImage(chartDataUrl, 'PNG', margin, 140, pageWidth - margin*2, 200);

    // General prose (explain risk index)
    const generalProse = "This report uses a risk-index designed to summarize local security conditions into an easy-to-understand score. The index combines multiple pieces of information about a place. First, the number and proximity of security facilities such as police stations, army installations and checkpoints are examined, because closer and more numerous facilities generally reduce local risk. Second, land-use patterns and how people use different parts of the area are considered, because some land uses attract or repel security incidents. Third, recorded incident counts, where available, provide context about historical problems in the area. Each of these elements is converted into a standard scale so they can be compared and combined. The scaled values are then combined into a single number that reflects relative security: higher numbers indicate higher risk. The final number is accompanied by a simple label—Low, Medium or High—so the outcome is easy to read. This approach explains relative differences between places rather than predicting exact events. The score is intended to help planners and managers quickly identify areas that need more attention or resources.";
    const yAfterChart = 360;
    doc.setFontSize(10);
    doc.text(doc.splitTextToSize(generalProse, pageWidth - margin*2), margin, yAfterChart + 18);

    // Specific narratives
    const regionNarrA = createRegionNarrative(regionNameA, aggA, avgA);
    const regionNarrB = createRegionNarrative(regionNameB, aggB, avgB);
    const comparative = createComparativeNarrative(regionNameA, aggA, avgA, regionNameB, aggB, avgB);

    let y = yAfterChart + 110;
    doc.setFont('helvetica','bold');
    doc.text('Regional Interpretation', margin, y);
    doc.setFont('helvetica','normal');
    y += 14;
    doc.text(doc.splitTextToSize(regionNarrA, pageWidth - margin*2), margin, y);
    y += (doc.splitTextToSize(regionNarrA, pageWidth - margin*2).length * 12) + 6;
    doc.text(doc.splitTextToSize(regionNarrB, pageWidth - margin*2), margin, y);
    y += (doc.splitTextToSize(regionNarrB, pageWidth - margin*2).length * 12) + 10;

    doc.setFont('helvetica','bold');
    doc.text('Comparative Interpretation', margin, y);
    doc.setFont('helvetica','normal');
    y += 14;
    doc.text(doc.splitTextToSize(comparative, pageWidth - margin*2), margin, y);

    // small stats table
    y += (doc.splitTextToSize(comparative, pageWidth - margin*2).length * 12) + 16;
    doc.setFont('helvetica','bold');
    doc.text('Summary counts (facility types)', margin, y);
    y += 12;
    doc.setFont('helvetica','normal');
    doc.text(`${regionNameA}: Police ${aggA.police}, Army ${aggA.army}, Checkpoints ${aggA.checkpoints}`, margin, y);
    y += 12;
    doc.text(`${regionNameB}: Police ${aggB.police}, Army ${aggB.army}, Checkpoints ${aggB.checkpoints}`, margin, y);

    // Footer: Geoinfotech Lagos contact details (from public website)
    const footer = "Geoinfotech - Lagos: Oluwalogbon House, Testing Ground Bus Stop, Obafemi Awolowo Way, Ikeja, Lagos. Phone: 08163222177, 08134101202. Email: contact@geoinfotech.ng";
    const footerY = doc.internal.pageSize.getHeight() - 40;
    doc.setFontSize(9);
    doc.text(footer, margin, footerY);

    doc.save(`comparison_${regionNameA.replace(/\s+/g,'_')}_vs_${regionNameB.replace(/\s+/g,'_')}.pdf`);
  }

  // Hook up events
  btnCompare.addEventListener('click', (e)=>{
    const lvl = levelSel.value;
    const nameA = regionA.value;
    const nameB = regionB.value;
    if(!nameA || nameA.startsWith('--') || !nameB || nameB.startsWith('--')) {
      alert('Select both regions.');
      return;
    }
    const featsA = getFeaturesByName(lvl, nameA);
    const featsB = getFeaturesByName(lvl, nameB);
    if(featsA.length===0 || featsB.length===0){
      alert('Could not find geometries for one or both regions. Check naming.');
      return;
    }
    renderComparison(nameA, featsA, nameB, featsB);
  });

  btnResetView.addEventListener('click', ()=>{
    highlightSource.clear();
    popup.style.display = 'none';
    // fit to whole risk layer if available
    if(riskGeo && riskGeo.features){
      const all = riskGeo.features;
      fitToFeatures(all.slice(0, Math.min(all.length, 40))); // sample to avoid heavy ops
      view.setZoom(5);
    } else {
      view.setCenter(ol.proj.fromLonLat([7.5,9.0]));
      view.setZoom(5);
    }
  });

  closePopup.addEventListener('click', ()=>{ popup.style.display='none'; highlightSource.clear(); });
  btnClose.addEventListener('click', ()=>{ popup.style.display='none'; highlightSource.clear(); });

  btnDownloadPdf.addEventListener('click', async ()=>{
    await generatePdfForComparison(popup.currentData);
  });

  // Search field logic: search and produce single-region PDF request
  async function handleSearch(){
    const q = searchInput.value && searchInput.value.trim();
    if(!q) return alert('Type a state, LGA or ward name.');
    // try to find matching feature (state/lga/ward)
    const lvlCandidates = ['state','lga','ward'];
    let found = null;
    let foundLevel = null;
    for(const lvl of lvlCandidates){
      const feats = getFeaturesByName(lvl, q);
      if(feats && feats.length){
        found = feats;
        foundLevel = lvl;
        break;
      }
    }
    if(!found){
      alert('No matching region found. Try exact names.');
      return;
    }
    // Highlight and fit
    highlightSource.clear();
    highlightGeoJsonFeatures(found, '#264653');
    fitToFeatures(found);
    // generate aggregated stats for the single region
    const agg = {police:0, army:0, checkpoints:0, riskValues:[]};
    for(const f of found){
      const c = countFacilitiesInFeature(f);
      agg.police += c.police; agg.army += c.army; agg.checkpoints += c.checkpoints;
      const rv = f.properties && f.properties[fields.riskField] !== undefined ? Number(f.properties[fields.riskField]) : null;
      if(rv !== null && !isNaN(rv)) agg.riskValues.push(rv);
    }
    const avg = agg.riskValues.length ? (agg.riskValues.reduce((s,x)=>s+x,0)/agg.riskValues.length) : null;

    // create a quick chart comparing facilities (single bar set)
    if(currentChart) currentChart.destroy();
    currentChart = new Chart(chartCanvas, {
      type:'bar',
      data:{
        labels:['Police','Army','Checkpoints'],
        datasets:[{label:q, data:[agg.police,agg.army,agg.checkpoints], backgroundColor:'rgba(75,192,192,0.6)'}]
      },
      options:{responsive:true, scales:{y:{beginAtZero:true}}}
    });

    document.getElementById('modal-title').textContent = `Report: ${q}`;
    popup.style.display = 'block';
    popup.currentData = {regionNameA:q, regionNameB:q, aggA:agg, aggB:agg, avgA:avg, avgB:avg};
    // show a special single-region download flow: clicking download will produce single-region style PDF
    btnDownloadPdf.onclick = async ()=>{
      // reuse generatePdfForComparison but pass same region for both slots so the pdf contains the specific narrative
      await generatePdfForComparison(popup.currentData);
      // restore consistent handler
      btnDownloadPdf.onclick = null;
      btnDownloadPdf.addEventListener('click', async ()=> await generatePdfForComparison(popup.currentData));
    };
  }

  btnSearch.addEventListener('click', handleSearch);
  searchInput.addEventListener('keydown', (ev)=>{ if(ev.key === 'Enter') handleSearch(); });

  // Small convenience: when popup closes remove highlights
  window.addEventListener('click', (ev)=>{
    if(ev.target === popup) return;
  });

  // End of compare.js
})();

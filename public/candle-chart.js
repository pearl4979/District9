/* District9 adapter for the locally vendored TradingView Lightweight Charts 5.2.1.
 * Engine: Apache-2.0; licenses/lightweight-charts-LICENSE.txt and NOTICE.txt.
 * Only canonical market buckets enter this layer. Milliseconds stay the public
 * contract; UTC seconds are used exclusively at the engine boundary.
 */
'use strict';
const hasCandleOHLC=candle=>candle?.gap!==true&&['o','h','l','c'].every(key=>Number.isFinite(candle?.[key]));
const candleBoundary=(before,after)=>after?.gapBefore===true||['source','segment'].some(key=>before?.[key]!=null&&after?.[key]!=null&&before[key]!==after[key]);
// Continuity is a display convention, never a rewrite of source market data.
// Hover receives both the displayed OHLC and its original source values.
function priorCloseDisplay(rows) {
  let previous=null;
  return rows.map(candle=>{
    if(!hasCandleOHLC(candle)){previous=null;return candle;}
    const raw={o:candle.o,h:candle.h,l:candle.l,c:candle.c};
    const o=previous&&!candleBoundary(previous,candle)?previous.c:candle.o;
    const displayed={...candle,o,h:Math.max(candle.h,o),l:Math.min(candle.l,o),raw,display:'prior-close'};
    previous=displayed;return displayed;
  });
}
window.AgentCandleChart = {
  // Missing known-volume buckets carry the previous close and zero volume.
  // Unknown sample volume remains null, and nothing predates the first sample.
  continuous(candles, intervalMs, {until, limit=300}={}) {
    if (!candles.length || !(intervalMs>0)) return candles;
    const end=Math.max(candles.at(-1).t,Math.floor((Number.isFinite(until)?until:candles.at(-1).t)/intervalMs)*intervalMs);
    const start=Math.max(candles[0].t,end-(limit-1)*intervalMs),out=[];
    let cursor=0,last=null;
    while(cursor<candles.length&&candles[cursor].t<start)last=candles[cursor++];
    for(let t=start;t<=end;t+=intervalMs) {
      if(cursor<candles.length&&candles[cursor].t===t){last=candles[cursor++];out.push(last);}
      else if(last) {
        // A missing-data sentinel or an explicitly separated source is not a
        // known no-trade interval. Keep it as engine whitespace until coverage
        // resumes; never carry a price through unavailable FX or history.
        if(!hasCandleOHLC(last)||candleBoundary(last,candles[cursor]))out.push({t,gap:true,v:null});
        else out.push({t,o:last.c,h:last.c,l:last.c,c:last.c,v:last.v===null?null:0,idle:true,source:last.source,segment:last.segment});
      }
    }
    return out;
  },
  create(host,{onHover=()=>{},onLayout=()=>{},onHistoryNeeded=()=>{}}={}) {
    const L=window.LightweightCharts;
    if(!L?.createChart)throw new Error('The local Lightweight Charts engine is unavailable');
    const MAX_BARS=5000,UP='#00c58e',DOWN='#f23555';
    let data=[],settings={intervalMs:60000,timeMode:'continuous'},seriesKey=null,destroyed=false,applying=false,graduationLine=null;
    let pendingHistory=null,requestedCursor=null,generation=0,layoutFrame=null,dragging=false,hoverTime=null;
    const price=n=>{
      if(!Number.isFinite(n))return '—';
      if(n<0)return '';
      const prefix=/USD/i.test(settings.priceUnit||'')?'$':'';
      if(settings.mode==='marketcap')for(const [base,suffix]of [[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']])if(Math.abs(n)>=base)return `${prefix}${Number((n/base).toFixed(2))}${suffix}`;
      if(n!==0&&Math.abs(n)<.000001)return `${prefix}${Number(n.toPrecision(5))}`;
      return prefix+Number(n.toPrecision(7)).toLocaleString('en-US',{maximumFractionDigits:10});
    };
    const milliseconds=time=>typeof time==='number'?time*1000:null;
    const timeLabel=(time,calendar=false)=>{
      const timestamp=milliseconds(time);if(timestamp===null)return '';
      return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...(calendar?{month:'2-digit',day:'2-digit'}:{hour:'2-digit',minute:'2-digit',...(settings.intervalMs<60000?{second:'2-digit'}:{}),hour12:false})}).format(new Date(timestamp));
    };
    const initial=host.getBoundingClientRect();
    const chart=L.createChart(host,{
      width:Math.max(1,Math.round(initial.width)),height:Math.max(1,Math.round(initial.height)),
      layout:{background:{type:L.ColorType.Solid,color:'#0d0d0d'},textColor:'#777777',fontSize:10,fontFamily:'SFMono-Regular, Menlo, monospace',attributionLogo:true},
      grid:{vertLines:{color:'#1c1c1c'},horzLines:{color:'#1c1c1c'}},
      crosshair:{mode:L.CrosshairMode.Normal,vertLine:{color:'#999999',width:1,style:L.LineStyle.Dashed,labelBackgroundColor:'#30333b',labelVisible:true},horzLine:{color:'#999999',width:1,style:L.LineStyle.Dashed,labelBackgroundColor:'#30333b',labelVisible:true}},
      rightPriceScale:{visible:true,borderColor:'#262626',scaleMargins:{top:.08,bottom:.20},autoScale:true,minimumWidth:68},
      leftPriceScale:{visible:false},
      timeScale:{visible:true,borderColor:'#262626',timeVisible:true,secondsVisible:false,rightOffset:6,barSpacing:6,minBarSpacing:2,fixLeftEdge:false,fixRightEdge:false,shiftVisibleRangeOnNewBar:true,tickMarkFormatter:(value,type)=>timeLabel(value,type<=2)},
      localization:{locale:'zh-CN',timeFormatter:value=>{const timestamp=milliseconds(value);return timestamp===null?'':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:settings.intervalMs<60000?'2-digit':undefined,hour12:false}).format(new Date(timestamp));}},
      handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},
      handleScale:{axisPressedMouseMove:{time:true,price:true},mouseWheel:true,pinch:true,axisDoubleClickReset:{time:true,price:true}},
    });
    const prices=chart.addSeries(L.CandlestickSeries,{
      upColor:UP,downColor:DOWN,borderUpColor:UP,borderDownColor:DOWN,wickUpColor:UP,wickDownColor:DOWN,
      priceLineStyle:L.LineStyle.Dotted,priceLineWidth:1,priceLineVisible:true,lastValueVisible:true,
      priceFormat:{type:'custom',formatter:price,minMove:.000001},
      autoscaleInfoProvider:original=>{
        const info=original(),target=settings.graduation?.value;
        if(info&&settings.fitTarget&&Number.isFinite(target)&&target>0)return {...info,priceRange:{minValue:Math.min(info.priceRange.minValue,target),maxValue:Math.max(info.priceRange.maxValue,target)}};
        return info;
      },
    });
    const volume=chart.addSeries(L.HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false,base:0});
    volume.priceScale().applyOptions({scaleMargins:{top:.85,bottom:0},visible:false});
    const scale=chart.timeScale();
    const latestCandle=()=>data.findLast(hasCandleOHLC);
    const emitHover=candle=>{if(!destroyed)onHover(candle||null);};
    function graduationGeometry(width,height,plotWidth,plotHeight,range) {
      const event=settings.graduationEvent,interval=settings.intervalMs;
      if(width<120||height<80||!(plotWidth>0)||!(plotHeight>0)||!range||!data.length||!event||typeof event.verified!=='boolean'||!['chain-event','official-index'].includes(event.proof)||(event.proof==='chain-event'&&!event.verified))return null;
      if(!Number.isSafeInteger(event.at)||event.at<=0||event.at>8_640_000_000_000_000||!Number.isSafeInteger(interval)||interval<=0)return null;
      const bucketTime=Math.floor(event.at/interval)*interval;
      if(event.at<data[0].t||event.at-data.at(-1).t>=interval)return null;
      // Position an event in the same canonical bucket as candles and wallet
      // markers. Activity time may omit that bucket: interpolate only between
      // coordinates of retained rows, without inserting a price or trade.
      let from=0,to=data.length;
      while(from<to){const middle=Math.floor((from+to)/2);if(data[middle].t<bucketTime)from=middle+1;else to=middle;}
      let x=null;
      if(data[from]?.t===bucketTime)x=scale.timeToCoordinate(bucketTime/1000);
      else if(from>0&&from<data.length){
        const before=data[from-1],after=data[from],left=scale.timeToCoordinate(before.t/1000),right=scale.timeToCoordinate(after.t/1000);
        if(Number.isFinite(left)&&Number.isFinite(right))x=left+(right-left)*(bucketTime-before.t)/(after.t-before.t);
      }
      return Number.isFinite(x)&&x>=0&&x<=plotWidth?{...event,x,bucketTime}:null;
    }
    function publishLayout() {
      if(destroyed)return;
      const box=host.getBoundingClientRect(),width=box.width,height=box.height;
      const range=scale.getVisibleLogicalRange(),plotWidth=scale.width(),plotHeight=Math.max(0,height-scale.height());
      const buckets=[];
      if(width>=120&&height>=80&&range) {
        const from=Math.max(0,Math.ceil(range.from)),to=Math.min(data.length-1,Math.floor(range.to));
        for(let index=from;index<=to;index++) {
          const candle=data[index];if(!hasCandleOHLC(candle))continue;
          const x=scale.timeToCoordinate(candle.t/1000),yTop=prices.priceToCoordinate(candle.h),yBottom=prices.priceToCoordinate(candle.l);
          if(Number.isFinite(x)&&Number.isFinite(yTop)&&Number.isFinite(yBottom)&&x>=0&&x<=plotWidth)buckets.push({t:candle.t,x,yTop,yBottom});
        }
      }
      const nativeSpacing=scale.options?.()?.barSpacing;
      const coordinateSpacing=buckets.length>1?Math.abs(buckets[1].x-buckets[0].x):0;
      const spacing=Number.isFinite(nativeSpacing)&&nativeSpacing>0?nativeSpacing:coordinateSpacing;
      const barWidth=buckets.length?Math.max(1,spacing*.8):0;
      onLayout({buckets,width,height,plotWidth,plotHeight,barWidth,intervalMs:settings.intervalMs,graduationEvent:graduationGeometry(width,height,plotWidth,plotHeight,range)});
    }
    function queueLayout() {
      if(destroyed||layoutFrame!==null||!window.requestAnimationFrame)return;
      layoutFrame=window.requestAnimationFrame(()=>{layoutFrame=null;publishLayout();if(dragging)queueLayout();});
    }
    function layoutChanged() {publishLayout();queueLayout();}
    function requestHistory(range) {
      if(destroyed||applying||!range||range.from>8||!settings.hasMore||!data.length||data.length>=MAX_BARS||pendingHistory)return;
      const before=data[0].t,cursor=`${seriesKey}:${before}`;
      if(requestedCursor===cursor)return;
      requestedCursor=cursor;
      const currentGeneration=generation,request={before,seriesKey};
      const pending={generation:currentGeneration};pendingHistory=pending;
      // Invoke synchronously so the controller can mark its independent request
      // before another range event. Rejections are surfaced by that controller.
      try {
        Promise.resolve(onHistoryNeeded(request)).catch(()=>{}).finally(()=>{
          if(!destroyed&&generation===currentGeneration&&pendingHistory===pending)pendingHistory=null;
        });
      } catch {if(pendingHistory===pending)pendingHistory=null;}
    }
    const rangeChanged=range=>{layoutChanged();requestHistory(range);};
    const sizeChanged=()=>layoutChanged();
    const crosshairChanged=event=>{
      if(applying||destroyed)return;
      const timestamp=milliseconds(event.time),candle=timestamp===null?null:data.find(row=>row.t===timestamp);
      hoverTime=candle?.t??null;
      emitHover(candle?(hasCandleOHLC(candle)?candle:null):latestCandle());layoutChanged();
    };
    chart.subscribeCrosshairMove(crosshairChanged);
    scale.subscribeVisibleLogicalRangeChange(rangeChanged);
    scale.subscribeSizeChange(sizeChanged);
    const resize=()=>{
      if(destroyed)return;
      const box=host.getBoundingClientRect();
      if(box.width>0&&box.height>0)chart.resize(Math.round(box.width),Math.round(box.height));
      layoutChanged();
    };
    // The public API exposes time-range changes, but price-axis zoom can keep
    // that range fixed. DOM gesture events plus the next frame keep overlays in
    // sync with the engine's vertical scale during drag, pinch and wheel zoom.
    const pointerDown=()=>{dragging=true;layoutChanged();};
    const pointerEnd=()=>{dragging=false;layoutChanged();};
    const pointerLeave=()=>{dragging=false;hoverTime=null;chart.clearCrosshairPosition();emitHover(latestCandle());layoutChanged();};
    const gesture=()=>layoutChanged();
    const domHandlers=[['pointerdown',pointerDown],['pointermove',gesture],['pointerup',pointerEnd],['pointercancel',pointerEnd],['pointerleave',pointerLeave],['wheel',gesture],['touchmove',gesture],['dblclick',gesture]];
    for(const [name,handler]of domHandlers)host.addEventListener(name,handler);
    window.addEventListener('resize',resize);
    const observer=window.ResizeObserver?new window.ResizeObserver(resize):null;observer?.observe(host);
    function encoded(rows) {
      let previousUp=true;
      return rows.map(candle=>{
        if(!hasCandleOHLC(candle)){previousUp=true;return {price:{time:candle.t/1000},volume:{time:candle.t/1000}};}
        const quiet=(candle.v===0||candle.idle===true)&&candle.o===candle.c&&candle.h===candle.c&&candle.l===candle.c;
        const up=quiet?previousUp:candle.c>=candle.o;if(!quiet)previousUp=up;
        const color=up?UP:DOWN;
        return {price:{time:candle.t/1000,open:candle.o,high:candle.h,low:candle.l,close:candle.c,color,borderColor:color,wickColor:color},volume:candle.v===null?{time:candle.t/1000}:{time:candle.t/1000,value:candle.v,color:up?'#00c58e55':'#f2355555'}};
      });
    }
    const same=(a,b)=>a&&b&&a.price.time===b.price.time&&a.price.open===b.price.open&&a.price.high===b.price.high&&a.price.low===b.price.low&&a.price.close===b.price.close&&a.price.color===b.price.color&&a.volume.value===b.volume.value;
    function latestView() {
      if(!data.length)return;
      scale.applyOptions({minBarSpacing:2});
      const width=scale.width()||host.getBoundingClientRect().width;
      const visible=Math.min(data.length,130,Math.max(35,Math.floor(width/6))),rightOffset=Math.max(1,Math.min(5,Math.round(visible*.04)));
      const to=data.length-1+rightOffset,from=Math.min(Math.max(-.5,data.length-visible-.5),to-width/10);
      scale.setVisibleLogicalRange({from,to});
      prices.priceScale().applyOptions({autoScale:true});
    }
    function setData(candles,options={}) {
      if(destroyed)return;
      const previousData=data,previousOptions=settings,oldRange=scale.getVisibleLogicalRange();
      settings={...settings,...options,graduationEvent:options.graduationEvent?{...options.graduationEvent}:null};
      const nextKey=options.seriesKey??`${settings.intervalMs}:${settings.mode||'price'}:${settings.priceUnit||''}`;
      const reset=options.reset===true||nextKey!==seriesKey||settings.intervalMs!==previousOptions.intervalMs||settings.mode!==previousOptions.mode||settings.priceUnit!==previousOptions.priceUnit;
      if(reset){generation++;pendingHistory=null;requestedCursor=null;hoverTime=null;}
      seriesKey=nextKey;
      const canonical=new Map();
      for(const candle of candles||[])if(Number.isFinite(candle?.t))canonical.set(candle.t,hasCandleOHLC(candle)?{...candle,v:Number.isFinite(candle.v)&&candle.v>=0?candle.v:null}:{t:candle.t,gap:true,v:null});
      const rows=[...canonical.values()].sort((a,b)=>a.t-b.t);
      if(settings.timeMode==='activity') {
        const traded=rows.filter(candle=>candle.idle!==true||!hasCandleOHLC(candle));
        data=(traded.length?traded:rows.slice(-1)).slice(-MAX_BARS);
      } else data=window.AgentCandleChart.continuous(rows,settings.intervalMs,{until:settings.until,limit:MAX_BARS}).slice(-MAX_BARS);
      data=priorCloseDisplay(data);
      const before=encoded(previousData),after=encoded(data);
      applying=true;
      try {
        if(reset||!data.length){hoverTime=null;chart.clearCrosshairPosition();}
        let changed=0;while(changed<Math.min(before.length,after.length)&&same(before[changed],after[changed]))changed++;
        const tailOnly=!reset&&before.length>0&&after.length>=before.length&&changed>=before.length-1;
        if(tailOnly) {
          for(let i=changed;i<after.length;i++){prices.update(after[i].price);volume.update(after[i].volume);}
        } else {
          prices.setData(after.map(row=>row.price));volume.setData(after.map(row=>row.volume));
        }
        const minPrice=Math.min(...data.filter(hasCandleOHLC).map(row=>Math.min(row.o,row.h,row.l,row.c)).filter(value=>value>0));
        const minMove=Number.isFinite(minPrice)&&minPrice>0?10**(Math.floor(Math.log10(minPrice))-4):.000001;
        prices.applyOptions({priceFormat:{type:'custom',formatter:price,minMove}});
        volume.applyOptions({visible:settings.volumeKnown!==false});
        scale.applyOptions({secondsVisible:settings.intervalMs<60000});
        const target=settings.graduation?.value;
        if(Number.isFinite(target)&&target>0){
          const line={price:target,color:'#d9b84e',lineWidth:1,lineStyle:L.LineStyle.Dashed,axisLabelVisible:true,title:'毕业线'};
          if(graduationLine)graduationLine.applyOptions(line);else graduationLine=prices.createPriceLine(line);
        }else if(graduationLine){prices.removePriceLine(graduationLine);graduationLine=null;}
        if(data.length) {
          if(reset||!previousData.length||!oldRange)latestView();
          else if(!tailOnly) {
            const anchor=Math.max(0,Math.min(previousData.length-1,Math.floor(oldRange.from))),timestamp=previousData[anchor].t,index=data.findIndex(row=>row.t===timestamp);
            if(index>=0){const shift=index-anchor;scale.setVisibleLogicalRange({from:oldRange.from+shift,to:oldRange.to+shift});}
            else latestView();
          }
        }
      }finally{applying=false;}
      const hovered=hoverTime===null?null:data.find(row=>row.t===hoverTime);
      if(!hovered)hoverTime=null;
      emitHover(hovered?(hasCandleOHLC(hovered)?hovered:null):latestCandle());layoutChanged();requestHistory(scale.getVisibleLogicalRange());
    }
    return {
      setData,
      fitAll() {
        if(destroyed||!data.length)return false;
        const width=scale.width()||host.getBoundingClientRect().width;if(!(width>0))return false;
        const padding=Math.max(1,Math.min(5,Math.round(data.length*.02))),to=data.length-1+padding,from=Math.min(-.5,to-width/10);
        // An explicit overview may be denser than ordinary navigation. The
        // loaded 5000-bar cap still applies; changing the view never fetches.
        applying=true;
        try {
          scale.applyOptions({minBarSpacing:Math.min(.5,width/(to-from+1))});
          scale.setVisibleLogicalRange({from,to});prices.priceScale().applyOptions({autoScale:true});
        }finally{applying=false;}
        hoverTime=null;chart.clearCrosshairPosition();emitHover(latestCandle());layoutChanged();return true;
      },
      focusTime(timestamp) {
        if(destroyed||!Number.isFinite(timestamp)||!(settings.intervalMs>0))return false;
        const bucket=Math.floor(timestamp/settings.intervalMs)*settings.intervalMs,index=data.findIndex(row=>row.t===bucket&&hasCandleOHLC(row));if(index<0)return false;
        const range=scale.getVisibleLogicalRange(),span=range?Math.max(15,range.to-range.from):100;
        hoverTime=data[index].t;
        scale.setVisibleLogicalRange({from:index-span/2,to:index+span/2});chart.setCrosshairPosition(data[index].c,data[index].t/1000,prices);emitHover(data[index]);layoutChanged();return true;
      },
      reset(){if(destroyed)return;hoverTime=null;latestView();chart.clearCrosshairPosition();emitHover(latestCandle());layoutChanged();},
      scrollToLatest(){if(destroyed)return;hoverTime=null;scale.applyOptions({minBarSpacing:2});scale.scrollToRealTime();chart.clearCrosshairPosition();emitHover(latestCandle());layoutChanged();},
      clear(){setData([],{hasMore:false});chart.clearCrosshairPosition();},
      destroy(){
        if(destroyed)return;destroyed=true;generation++;pendingHistory=null;
        const box=host.getBoundingClientRect(),plotWidth=scale.width(),plotHeight=Math.max(0,box.height-scale.height());
        data=[];settings={...settings,graduationEvent:null};
        if(layoutFrame!==null)window.cancelAnimationFrame?.(layoutFrame);layoutFrame=null;
        observer?.disconnect();window.removeEventListener('resize',resize);
        for(const [name,handler]of domHandlers)host.removeEventListener(name,handler);
        chart.unsubscribeCrosshairMove(crosshairChanged);scale.unsubscribeVisibleLogicalRangeChange(rangeChanged);scale.unsubscribeSizeChange(sizeChanged);chart.remove();
        onLayout({buckets:[],width:box.width,height:box.height,plotWidth,plotHeight,barWidth:0,intervalMs:settings.intervalMs,graduationEvent:null});
      },
    };
  },
};

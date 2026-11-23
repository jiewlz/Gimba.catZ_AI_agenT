// The cat illustration engine from 金霸毛色配種實驗室 (the cattery's own coat-colour lab page),
// plus a long-hair layer. Injected into the chat page as plain browser JS.
export const CAT_CSS = `
.cat stop{transition:stop-color .7s ease}
.cat .ring,.cat .strp,.cat .ptf,.cat .pts,.cat .fur{transition:opacity .6s ease, fill .7s ease, stroke .7s ease}
.cat path.ring{fill:none!important}
.cat .tw,.cat .ws1,.cat .ws2,.cat .bib{transition:opacity .6s ease, fill .7s ease}
.cat .iris,.cat .nose,.cat .pad{transition:fill .7s ease}
.cat .upper,.cat .leg{transition:transform .6s cubic-bezier(.5,1.6,.5,1)}
.cat .leg{transform-box:fill-box;transform-origin:50% 100%}
.cat.short .upper{transform:translateY(20px)}
.cat.short .leg{transform:scaleY(.42)}
.cat .fur{opacity:0}
.cat.long .fur{opacity:1}
.cat .eye{transform-box:fill-box;transform-origin:50% 50%}
.cat .tail{transform-box:view-box;transform-origin:150px 200px}
.cat .ear{transform-box:fill-box;transform-origin:50% 100%}
@media (prefers-reduced-motion:no-preference){
  .cat .eye{animation:blink 5s infinite}
  .cat .tail{animation:sway 4.2s ease-in-out infinite}
  .cat .earR{animation:twitch 7s infinite}
  .cat .torso{animation:breathe 3.6s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 100%}
  .cat.hop{animation:hop .5s ease}
}
@keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.08)}}
@keyframes sway{0%,100%{transform:rotate(0)}50%{transform:rotate(-9deg)}}
@keyframes twitch{0%,88%,94%,100%{transform:rotate(0)}91%{transform:rotate(9deg)}}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.015,1.025)}}
@keyframes hop{0%{transform:translateY(0)}35%{transform:translateY(-10px)}70%{transform:translateY(0)}85%{transform:translateY(-2px)}100%{transform:translateY(0)}}
`;

export const CAT_JS = `
var EU={n:'#2c2724',b:'#5d3c2b',o:'#8d5a3b',a:'#737e8b',c:'#ab9da6',p:'#c6a78e'};
var RED={d:'#c8733a',e:'#e4c29a'};
function hx(h){return [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)]}
function mix(a,b,t){var x=hx(a),y=hx(b);return '#'+[0,1,2].map(function(i){return Math.round(x[i]+(y[i]-x[i])*t).toString(16).padStart(2,'0')}).join('')}
function palette(p){
  var base=p.red==='red'?RED[p.dil?'e':'d']:EU[p.eu];
  var patch=RED[p.dil?'e':'d'];
  var under;
  if(p.pat==='silver'||p.pat==='smoke') under='#f2f0eb';
  else if(p.red==='red') under=p.dil?'#f4e0c6':'#efc390';
  else if(p.eu==='c') under='#f2dccd';                  // 紫金：粉米色底
  else under=p.dil?'#efd6b0':'#e8b977';
  var s0,s1,s2,bib;
  if(p.pat==='solid'){s0=s1=s2=base;bib=0}
  else if(p.pat==='smoke'){s0=base;s1=mix(base,under,.12);s2=mix(base,under,.5);bib=.45}
  else if(p.lvl===25){s0=base;s1=mix(base,under,.24);s2=mix(base,under,.7);bib=.6}
  else if(p.lvl===11){s0=base;s1=mix(base,under,.5);s2=under;bib=.9}
  else{s0=mix(base,under,.35);s1=mix(base,under,.78);s2=under;bib=1}
  if(p.pat!=='solid'&&p.pat!=='smoke') patch=mix(patch,under,.3);
  var eye=(p.pat==='golden'&&p.red==='none')?'#4e9852':(p.pat==='silver'?'#5fae6b':'#d4892a');
  var nose=(p.pat==='solid'||p.pat==='smoke')&&(p.eu==='n')&&p.red==='none'?'#4a3c37':(p.dil?'#c99aa0':'#bf6b5c');
  var point=s0;
  if(p.pt){s0=mix(s0,'#f4ede1',.82);s1=mix(s1,'#f4ede1',.82);s2=mix(s2,'#f6f0e6',.65);eye='#5b8fd6';}
  var shd=p.pat==='golden'||p.pat==='silver';
  var ring=shd?[.75,.35,0][p.tiN]:0, strp=shd&&p.tiN===0?.45:0;
  var pad=p.pat==='solid'?mix(base,'#ffffff',.14):mix(s2,'#ffffff',.25);
  if(p.allwhite){s0=s1=s2=point='#f5f2ec';bib=0;ring=0;strp=0;nose='#e7a19a';pad='#efb7b0'}
  return {pt:p.pt?1:0,point:point,ring:ring,strp:strp,base:base,s0:s0,s1:s1,s2:s2,under:under,bib:bib,patch:patch,eye:eye,nose:nose,pad:pad};
}
var uid=0;
function catSVG(){
  var id='c'+(uid++), F='url(#'+id+'f)', ST='rgba(40,30,25,.22)';
  return '<svg class="cat" id="'+id+'" viewBox="0 0 200 222" role="img" aria-label="依你的偏好畫出的貓咪">'+
  '<defs><linearGradient id="'+id+'f" x1="0" y1="0" x2="0" y2="1">'+
    '<stop class="s0" offset="0"/><stop class="s1" offset=".5"/><stop class="s2" offset="1"/></linearGradient>'+
    '<filter id="'+id+'b" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter></defs>'+
  '<g class="tail"><path class="fur" d="M150 200 C186 198 194 160 174 136" fill="none" stroke="'+ST+'" stroke-width="30" stroke-linecap="round"/>'+
    '<path class="fur" d="M150 200 C186 198 194 160 174 136" fill="none" stroke="'+F+'" stroke-width="27" stroke-linecap="round"/>'+
    '<path d="M150 200 C186 198 194 160 174 136" fill="none" stroke="'+ST+'" stroke-width="18" stroke-linecap="round"/>'+
    '<path d="M150 200 C186 198 194 160 174 136" fill="none" stroke="'+F+'" stroke-width="15" stroke-linecap="round"/><path class="pts" d="M150 200 C186 198 194 160 174 136" fill="none" stroke-width="15" stroke-linecap="round" opacity="0"/><path class="ring" d="M150 200 C186 198 194 160 174 136" fill="none" stroke-width="15" stroke-dasharray="4 9" opacity="0"/></g>'+
  '<g class="haunch"><ellipse cx="100" cy="196" rx="66" ry="20" fill="'+F+'" stroke="'+ST+'"/>'+
    '<ellipse class="ws1" cx="100" cy="203" rx="40" ry="11" fill="#fbfaf6" opacity="0"/>'+
    '<ellipse class="ws2" cx="100" cy="196" rx="64" ry="19" fill="#fbfaf6" opacity="0"/>'+
    '<path class="tw" d="M44 192 C46 182 62 180 70 186 C72 196 58 204 46 200Z" opacity="0"/></g>'+
  '<g class="upper">'+
    '<g class="torso"><path d="M100 94 C144 94 160 130 158 168 C156 192 44 192 42 168 C40 130 56 94 100 94Z" fill="'+F+'" stroke="'+ST+'"/>'+
    '<ellipse class="bib" cx="100" cy="142" rx="28" ry="34" opacity="0"/>'+
    '<g class="strp" fill="none" stroke-width="4" stroke-linecap="round" opacity="0"><path d="M47 126 Q57 122 64 131 M44 144 Q56 139 64 148 M45 162 Q56 157 63 166 M153 126 Q143 122 136 131 M156 144 Q144 139 136 148 M155 162 Q144 157 137 166"/></g>'+
    '<path class="tw" d="M128 118 C146 120 152 142 146 158 C136 160 124 146 122 132Z" opacity="0"/>'+
    '<path class="ws1" d="M100 110 C120 110 128 140 126 188 L74 188 C72 140 80 110 100 110Z" fill="#fbfaf6" opacity="0"/>'+
    '<path class="ws2" d="M100 96 C142 96 157 130 156 168 C154 190 46 190 44 168 C43 130 58 96 100 96Z" fill="#fbfaf6" opacity="0"/></g>'+
    '<path class="fur" d="M44 94 L34 104 L46 108 L36 120 L52 120 L46 132 L62 128 L64 140 L78 132 L86 142 L100 134 L114 142 L122 132 L136 140 L138 128 L154 132 L148 120 L164 120 L154 108 L166 104 L156 94Z" fill="'+F+'" stroke="'+ST+'" stroke-linejoin="round"/>'+
    '<g class="head">'+
      '<g class="ear earL"><path d="M54 66 L58 20 L90 44Z" fill="'+F+'" stroke="'+ST+'" stroke-linejoin="round"/><path class="ptf" d="M55 64 L58 22 L88 44Z" opacity="0"/><path d="M60 58 L62 30 L82 46Z" fill="#e3a59c" opacity=".8"/></g>'+
      '<g class="ear earR"><path d="M146 66 L142 20 L110 44Z" fill="'+F+'" stroke="'+ST+'" stroke-linejoin="round"/><path class="ptf" d="M145 64 L142 22 L112 44Z" opacity="0"/><path d="M140 58 L138 30 L118 46Z" fill="#e3a59c" opacity=".8"/></g>'+
      '<path d="M100 34 C142 34 160 60 158 88 C156 114 130 128 100 128 C70 128 44 114 42 88 C40 60 58 34 100 34Z" fill="'+F+'" stroke="'+ST+'"/>'+
      '<g class="strp" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" opacity="0"><path d="M86 46 L90 60 L100 52 L110 60 L114 46 M48 90 Q58 87 66 94 M152 90 Q142 87 134 94 M50 100 Q58 99 64 104 M150 100 Q142 99 136 104"/></g>'+
      '<path class="tw" d="M70 42 C84 36 96 44 92 58 C84 66 66 62 62 54Z" opacity="0"/>'+
      '<path class="tw" d="M140 90 C152 92 154 106 146 114 C136 116 130 104 132 96Z" opacity="0"/>'+
      '<ellipse class="ptf mask" cx="100" cy="100" rx="30" ry="25" opacity="0" filter="url(#'+id+'b)"/>'+
      '<path class="ws1" d="M100 70 C110 84 124 98 128 114 C118 126 82 126 72 114 C76 98 90 84 100 70Z" fill="#fbfaf6" opacity="0"/>'+
      '<path class="ws2" d="M44 92 C60 82 80 78 100 78 C120 78 140 82 156 92 C152 116 128 128 100 128 C72 128 48 116 44 92Z" fill="#fbfaf6" opacity="0"/>'+
      '<ellipse class="pad" cx="89" cy="104" rx="13" ry="10"/><ellipse class="pad" cx="111" cy="104" rx="13" ry="10"/>'+
      '<g class="eye"><ellipse cx="78" cy="80" rx="11" ry="11.5" fill="#fbfaf6"/><circle class="iris" cx="78" cy="80" r="9.5"/><ellipse cx="78" cy="80.5" rx="3.2" ry="7" fill="#1b1714"/><circle cx="81" cy="76" r="2.4" fill="#fff"/></g>'+
      '<g class="eye"><ellipse cx="122" cy="80" rx="11" ry="11.5" fill="#fbfaf6"/><circle class="iris" cx="122" cy="80" r="9.5"/><ellipse cx="122" cy="80.5" rx="3.2" ry="7" fill="#1b1714"/><circle cx="125" cy="76" r="2.4" fill="#fff"/></g>'+
      '<path class="nose" d="M94 95 L106 95 L100 102Z" stroke-linejoin="round"/>'+
      '<path d="M100 102 L100 106 M100 106 C96 111 91 110 89 107 M100 106 C104 111 109 110 111 107" fill="none" stroke="rgba(40,30,25,.55)" stroke-width="1.4" stroke-linecap="round"/>'+
      '<g stroke="rgba(60,50,45,.35)" stroke-width="1" stroke-linecap="round"><path d="M80 104 L48 98 M80 108 L46 110 M120 104 L152 98 M120 108 L154 110"/></g>'+
    '</g>'+
  '</g>'+
  '<g class="leg"><rect x="70" y="148" width="24" height="62" rx="11" fill="'+F+'" stroke="'+ST+'"/><rect class="ptf" x="70" y="170" width="24" height="40" rx="11" opacity="0"/><g class="ring" opacity="0"><rect x="71" y="160" width="22" height="4" rx="2"/><rect x="71" y="172" width="22" height="4" rx="2"/><rect x="71" y="184" width="22" height="4" rx="2"/></g><rect class="ws1" x="70.5" y="182" width="23" height="28" rx="10" fill="#fbfaf6" opacity="0"/><rect class="ws2" x="70.5" y="149" width="23" height="61" rx="11" fill="#fbfaf6" opacity="0"/><path d="M78 204 L78 209 M86 204 L86 209" stroke="'+ST+'"/></g>'+
  '<g class="leg"><rect x="106" y="148" width="24" height="62" rx="11" fill="'+F+'" stroke="'+ST+'"/><rect class="ptf" x="106" y="170" width="24" height="40" rx="11" opacity="0"/><g class="ring" opacity="0"><rect x="107" y="160" width="22" height="4" rx="2"/><rect x="107" y="172" width="22" height="4" rx="2"/><rect x="107" y="184" width="22" height="4" rx="2"/></g><rect class="ws1" x="106.5" y="182" width="23" height="28" rx="10" fill="#fbfaf6" opacity="0"/><rect class="ws2" x="106.5" y="149" width="23" height="61" rx="11" fill="#fbfaf6" opacity="0"/><path d="M114 204 L114 209 M122 204 L122 209" stroke="'+ST+'"/></g>'+
  '</svg>';
}
function paint(svg,p,hop){
  var c=palette(p);
  svg.querySelector('.s0').style.stopColor=c.s0;
  svg.querySelector('.s1').style.stopColor=c.s1;
  svg.querySelector('.s2').style.stopColor=c.s2;
  svg.querySelectorAll('.bib').forEach(function(e){e.style.fill=c.under;e.style.opacity=c.bib});
  svg.querySelectorAll('.ptf').forEach(function(e){e.style.fill=c.point;e.style.opacity=c.pt?(e.classList.contains('mask')?.9:1):0});
  svg.querySelectorAll('.pts').forEach(function(e){e.style.stroke=c.point;e.style.opacity=c.pt});
  svg.querySelectorAll('.ring').forEach(function(e){e.style.fill=c.base;e.style.stroke=c.base;e.style.opacity=c.ring});
  svg.querySelectorAll('.strp').forEach(function(e){e.style.stroke=c.base;e.style.opacity=c.strp});
  svg.querySelectorAll('.tw').forEach(function(e){e.style.fill=c.patch;e.style.opacity=p.red==='tortie'?1:0});
  svg.querySelectorAll('.ws1').forEach(function(e){e.style.opacity=p.white>=1?1:0});
  svg.querySelectorAll('.ws2').forEach(function(e){e.style.opacity=p.white>=2?1:0});
  svg.querySelectorAll('.iris').forEach(function(e){e.style.fill=c.eye});
  svg.querySelectorAll('.pad').forEach(function(e){e.style.fill=p.white>=1?'#fbfaf6':(c.pt?mix(c.point,'#ffffff',.12):c.pad)});
  svg.querySelector('.nose').style.fill=c.nose;
  svg.classList.toggle('short',p.legs===1);
  svg.classList.toggle('long',!!p.longhair);
  if(hop){svg.classList.remove('hop');void svg.getBoundingClientRect();svg.classList.add('hop')}
}

/* Customer words -> look. Unknown parts stay at a neutral blue British shorthair.
   Each part of the colour is read on its own (base colour, red/tortie, pattern, white, points),
   so combinations such as 藍白, 藍金漸層, 銀虎斑, 三花, 海豹重點 come out right. */
function lookFromSlots(s){
  var breed=s.breed||'';
  var c=(s.color||'').replace(/乳白/g,'奶油');           // 台灣說的乳白是奶油色
  var p={letter:'a',eu:'a',red:'none',dil:true,pat:'solid',lvl:11,tiN:2,white:0,legs:0,pt:false,longhair:false,allwhite:false};
  if(/短腿|曼赤肯|小步舞曲/.test(breed)) p.legs=1;
  if(/長毛|英長/.test(breed+c)) p.longhair=true;
  // pattern
  var tabby=/虎斑|斑紋|條紋|鯖魚|古典斑/.test(c);
  if(/銀/.test(c)) p.pat='silver';
  else if(/金/.test(c)||tabby) p.pat='golden';
  else if(/煙/.test(c)) p.pat='smoke';
  if(tabby) p.tiN=0;
  if(/黑金|黑銀|深/.test(c)) p.lvl=25;                  // 黑金：尖端黑得比較多的漸層
  // red series
  if(/玳瑁|三花/.test(c)) p.red='tortie';
  else if(/奶油/.test(c)) p.red='red';
  else if(/紅|橘|橙|薑/.test(c)) p.red='red';
  // base colour: named > pattern default (black) > neutral blue
  var named=true;
  if(/淡紫|丁香|紫/.test(c)) p.eu='c';
  else if(/肉桂/.test(c)) p.eu='o';
  else if(/巧克力|咖啡|棕/.test(c)) p.eu='b';
  else if(/藍|灰/.test(c)) p.eu='a';
  else if(/黑|海豹/.test(c)) p.eu='n';
  else named=false;
  if(!named) p.eu=(p.pat!=='solid'||p.red==='tortie'||/重點|暹羅/.test(c))?'n':'a';
  p.dil=/^[ac]$/.test(p.eu)||/奶油|淡/.test(c);
  if(p.red==='red'&&!/奶油|淡/.test(c)) p.dil=false;
  // white
  var other=/藍|灰|黑|奶油|紅|橘|橙|金|銀|煙|玳瑁|三花|巧克力|咖啡|棕|肉桂|淡紫|丁香|紫|虎斑|斑|重點|海豹|暹羅/.test(c);
  if(/雙色|賓士|三花|梵/.test(c)||(/白/.test(c)&&other)) p.white=1;
  else if(/白/.test(c)) p.allwhite=true;
  if(/重點|暹羅|海豹/.test(c)) p.pt=true;
  return p;
}
function lookName(s){
  var b=s.breed||'', c=s.color||'';
  var kind=/曼赤肯|小步舞曲|英短|英長/.exec(b);
  var parts=[];
  parts.push(kind?kind[0]:(/短腿/.test(b)?'短腿寶寶':(/長腿/.test(b)?'長腿寶寶':'英短血系寶寶')));
  if(/長毛/.test(b)&&!/英長/.test(b)) parts.push('長毛');
  if(c) parts.push(c);
  return parts.join('・');
}
`;

%%
%% This is file `jurarsp.bst',
%% generated with the docstrip utility.
%%
%% The original source files were:
%%
%% jurarsp.dtx  (with options: `bibstyle')
%% 
%% IMPORTANT NOTICE:
%% 
%% For the copyright see the source file.
%% 
%% Any modified versions of this file must be renamed
%% with new filenames distinct from jurarsp.bst.
%% 
%% For distribution of the original source see the terms
%% for copying and modification in the file jurarsp.dtx.
%% 
%% This generated file may be distributed as long as the
%% original source files, as listed above, are part of the
%% same distribution. (The sources need not necessarily be
%% in the same archive or directory.)
%%
%% Written by Lucas Wartenburger
%%
ENTRY{
state % DE
jurisdiction % Ord. Gerichtsbarkeit
level % Bundesgerichte
place % Karlsruhe
courtname % Bundesgerichtshof oder Bundesmin. der Fin.
courtshort % BGH oder BMF
courtspecial % GrS
chamber % ("X ZR")
date % 26.9.1996
decision % Urteil / Beschluss / Vorlagebeschl.

official % Slg.
officialshort % E (statt BVerfGE)
officialyear % 1996
officialvolume % I
officialpages % 4551, 4570

journal % ("ZStW")
journalyear % ("1983")
journalvolume % ("94")
journalpages % ("493 ff.")

journaladditional % ("=JZ 93, 333")

name % Kimberly Clark
parties % Frankreich / Kommission
sign % C-241/94
language % FR
keyword % Selectivitätskriterium im Beihilfenrecht
laws % Artt. 87 ff. EG
commented % Pacteau, GdP 1845, 233 ff.
note % wohl Fehlurteil
annote % Kopien in Ordner R23

citeas % journal / official (j/o)

sortkeyg % manueller Sortierschluessel (Ger-Ebene)
  sortkeyu % manueller Sortierschluessel (Urt-Ebene)
  }
  { }
  { }

FUNCTION {not}
{   { #0 }
  { #1 }
  if$
}

FUNCTION {and}
{   'skip$
  { pop$ #0 }
  if$
}

FUNCTION {or}
{   { pop$ #1 }
  'skip$
  if$
}

FUNCTION {output.bibitem}
{ newline$
  "\rspitem[%" write$
  newline$
  " {" write$
    type$ empty$
{ "{}" write$ }
{ "{" type$ * "}" * write$ }
    if$
    state empty$
{ "{}" write$ }
{ "{" state * "}" * write$ }
    if$
    jurisdiction empty$
{ "{}" write$ }
{ "{" jurisdiction * "}" * write$ }
    if$
    level empty$
{ "{}" write$ }
{ "{" level * "}" * write$ }
    if$
    place empty$
{ "{}" write$ }
{ "{" place * "}" * write$ }
    if$
    courtname empty$
{ "{}" write$ }
{ "{" courtname * "}" * write$ }
    if$
  "}%" write$
  newline$

  " {" write$
    courtshort empty$
{ "{}" write$ }
{ "{" courtshort * "}" * write$ }
    if$
    courtspecial empty$
{ "{}" write$ }
{ "{" courtspecial * "}" * write$ }
    if$
    chamber empty$
{ "{}" write$ }
{ "{" chamber * "}" * write$ }
    if$
  "}%" write$
  newline$
}

FUNCTION {output.bibitem2}
{
  " {" write$
    date empty$
{ "{}" write$ }
{ "{" date * "}" * write$ }
    if$
    sign empty$
{ "{}" write$ }
{ "{" sign * "}" * write$ }
    if$
    parties empty$
   {"{}" write$ }
   {"{" parties * "}" * write$}
  if$
  name empty$
   {"{}" write$ }
   {"{" name * "}" * write$}
  if$
    decision empty$
{ "{}" write$ }
{ "{" decision * "}" * write$ }
    if$

  "}%" write$
  newline$

  " {" write$
    official empty$
{ "{}" write$ }
{ "{" official * "}" * write$ }
    if$
    officialshort empty$
{ "{}" write$ }
{ "{" officialshort * "}" * write$ }
    if$
    officialpages empty$
     {
     officialvolume empty$
      {
        officialyear empty$
         { "{}" write$ }
         { "{" officialyear * "}" * write$ }
        if$
      }
      {
        officialyear empty$
       { "{" officialvolume * "}" * write$ }
       { "{" officialyear * " " * officialvolume * "}" * write$ }
        if$
      }
     if$
    }
    {
       officialvolume empty$
    {
      officialyear empty$
       { "{" officialpages * "}" * write$ }
       { "{" officialyear * ", " * officialpages * "}" * write$ }
      if$
    }
    {
      officialyear empty$
       { "{" officialvolume * ", " * officialpages * "}" * write$ }
         { "{" officialyear * " " * officialvolume * ", " * officialpages * "}" * write$ }
        if$
      }
     if$
    }
    if$
  "}%" write$
  newline$

  " {" write$
    journal empty$
{ "{}" write$ }
{ "{" journal * "}" * write$ }
    if$
    journalpages empty$
{
  journalyear empty$
{"{}" write$}
{"{" journalyear * "}" * write$ }
  if$
}
{
  journalyear empty$
   {"{" journalpages * "}" * write$ }
{"{" journalyear * ", " * journalpages * "}" * write$ }
  if$
}
    if$
    journaladditional empty$
{ "{}" write$ }
{ "{" journaladditional * "}" * write$ }
    if$
  "}%" write$
  newline$
}

FUNCTION {output.bibitem3}
{
  " {" write$
  note empty$
   { "{}" write$ }
   { "{" note * "}" * write$ }
  if$
  annote empty$
   { "{}" write$ }
   { "{" annote * "}" * write$ }
  if$
  commented empty$
   { "{}" write$ }
   { "{" commented * "}" * write$ }
  if$
  citeas empty$
   { "{}" write$ }
   { "{" citeas * "}" * write$ }
  if$
  "}%" write$
  newline$
  "]%" write$
  newline$
  "{" cite$ * "}%" * write$
  newline$
}

FUNCTION {judgement}
{ output.bibitem
  output.bibitem2
  output.bibitem3
}

FUNCTION {court}{}

FUNCTION {institution}{}

FUNCTION {document}{
  output.bibitem
  output.bibitem2
  output.bibitem3
}

FUNCTION {default.type}{judgement}

READ

FUNCTION {sortify}{ purify$ "l" change.case$ }

FUNCTION {field.or.null}
{ duplicate$ empty$
  { pop$ "" }
  'skip$
  if$
}

FUNCTION {presort}
{
  type$ field.or.null sortify
  "    "
  *
  sortkeyg empty$
  {
     state field.or.null sortify
  }
  {
     sortkeyg field.or.null sortify
  }
  if$
  *
  "    "
  *
  jurisdiction field.or.null sortify
  *
  "    "
  *
  level field.or.null sortify
  *
  "    "
  *
  courtshort field.or.null sortify
  *
  "    "
  *

  sortkeyu empty$
  {
    officialpages empty$
{
journal field.or.null sortify
}
{
officialshort field.or.null sortify
}
    if$
  }
  {
    sortkeyu field.or.null sortify
  }
  if$
  *
  "    "
  *

    officialpages empty$
{
journalyear field.or.null sortify
*
"    "
*
journalvolume field.or.null sortify
*
"    "
*
journalpages field.or.null sortify
}
{
officialyear field.or.null sortify
*
"    "
*
officialvolume field.or.null sortify
*
"    "
*
officialpages field.or.null sortify
}
    if$
    *
  #1 entry.max$ substring$
  'sort.key$ :=
}

ITERATE {presort}

FUNCTION {before.sort} { "BEFORE SORT:" top$ }
EXECUTE {before.sort}
FUNCTION {print.sort.keys} {sort.key$ top$}
ITERATE {print.sort.keys}

SORT

FUNCTION {after.sort} {"AFTER SORT:" top$}
EXECUTE {after.sort}
ITERATE {print.sort.keys}

FUNCTION {begin.bib}
{ preamble$ empty$
    'skip$
    { "%" write$ newline$
      "% This bibliography was produced by using jurarsp.bst" write$ newline$
      "%" write$ newline$
      preamble$ write$ newline$
    }
  if$
  "\begin{thersplist}{}" write$ newline$
}

EXECUTE {begin.bib}

ITERATE {call.type$}

FUNCTION {end.bib}
{ newline$
  "\end{thersplist}" write$ newline$
}

EXECUTE {end.bib}

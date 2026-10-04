%----------------------------------------------------------------------------------------------------------------------------%
%----------------------------------------------------------------------------------------------------------------------------%

%>>>% Bib. style "alpha-persian", Persian (farsi)  version of alpha.bst and also for pdflatex compiler.
%>>>% by: Shapour Madadpour  March 2019
%>>>% E-mail: madad_sh@yahoo.com
%>>>%It has two user guide for persian language users (alpha-persian-p.userguide) and   english language users (alpha-persian-l.userguide).
%----------------------------------------------------------------------------------------------------------------------------%

%>>>% Thanks to Mahmoud Amintoosi  and  Mostafa Vahedi for creating the other bibtex styles in persian.
%----------------------------------------------------------------------------------------------------------------------------%

%>>>% For XePersian, a Persian Typesetting Package in XeTeX and also for pdflatex with help of the following commands:
%%%%%\let\lr\relax  %\let\setlatin\relax %\let\resetlatinfont\relax %\newenvironment{LTRbibitems}{}{}%%%%
%>>>% It may be distributed and/or modified under the
%>>>% conditions of the LaTeX Project Public License (version 1.3c), 
%>>>% either this version of this license or (at your option) any later version.
%>>>% This style has\noopsort command for sort the references manually.
%-----------------------------------------------------------------------------------------------------------------------------%

% BibTeX standard bibliography style `alpha'
   % Version 0.99b (8-Dec-10 release) for BibTeX versions 0.99a or later.
   % Copyright (C) 1984, 1985, 1988, 2010 Howard Trickey and Oren Patashnik.
   % Unlimited copying and redistribution of this file are permitted as long as
   % it is unmodified.  Modifications (and redistribution of modified versions)
   % are also permitted, but only if the resulting file is renamed to something
   % besides btxbst.doc, plain.bst, unsrt.bst, alpha.bst, and abbrv.bst.
   % This restriction helps ensure that all standard styles are identical.
   % The file btxbst.doc has the documentation for this style.
%------------------------------------------------------------------------------------------------------------------------------%

%>>>%  This style has all of properties alpha style. in addition to:
%++++++%%++++++++++++++++++++++++++++++++++++++++++++%    Changes    %++++++%%+++++++++++++++++++++++++++++++++++++++++++++++++%
%>>+ The title  structure, has essentially changed.
%>>+ isbn Added. It Writes in Persian style "شابک".
%>>+ issn Added. It Writes in Persian style "شاپا".
%>>+ doi Added. It Writes in Persian style "شناسه‌ی دیجیتال".
%>>+ slabel Added. slabel field is used for arbitrary label.
%>>+ mlabel Added. mlabel field is used for a part of manual alpha style (just for author name and \etalchar) label in persian.
%>>+ madadurltest Added. madadurltest field  is needed for title (with link).
%>>+ murl Added. murl field is used for when you want to your title be with link.
%>>+ quotation  Added. quotation field is used for when you want to your title be with quotation mark.
%>>+ Compatible with hyperref, url, natbib and cite packages
%-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------%
%-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------%

ENTRY
{address
author          % Set for english and persian language(LTR and RTL text).with et~al in persian and english.
booktitle
chapter         % Set for english and persian language(LTR and RTL text).
doi             %---Added and set for english and persian language(LTR and RTL text)---%It Writes in Persian style "شناسه‌ی دیجیتال".
edition         % Set for english and persian language(LTR and RTL text).
editor          % Set for english and persian language(LTR and RTL text).
howpublished
institution
isbn            %---Added and it set for english and persian language(LTR and RTL text)---%It Writes in Persian style "شابک".
issn            %---Added and it set for english and persian language(LTR and RTL text)---%It Writes in Persian style "شاپا".
journal
key
language        %---Added and  it set for  persian language(RTL text)---%
madadurltest    %---Added and  it set for english and persian language(LTR and RTL text)---%madadurltest={1},(with murl field)
                % is needed for title with link(this structure different from key structure). 
mlabel          %---Added and it set for english and persian language(LTR and RTL text)---%mlabel field is used for a part of manual alpha style (just for author name 
                %---and \etalchar) label in persian.
month
murl            %---Added and set for english and persian language(LTR and RTL text)---%murl field is used for when you want to your title be with link(with madadurltest={1} field).
note
number          % Set for english and persian language(LTR and RTL text).
organization
pages           % Set for english and persian language(LTR and RTL text).
publisher
quotation       %---Added and set for english and persian language(LTR and RTL text)---%quotation field is used for when you want to your title be with quotation mark.
school
series          % Set for english and persian language(LTR and RTL text).
slabel          %---Added and set for english and persian language(LTR and RTL text)---%slabel field is used for arbitrary label.(this structure different from key structure).
title           % The title  structure, has essentially changed. You can link it by fill in the murl field  with madadurltest={1} in the bibfile. Also you can show title with
                % or Without. quotation mark by fill in the questiton field in the bibfile.
type
url             %---Added and set for english and persian language(LTR and RTL text)---%   
volume          % Set for english and persian language(LTR and RTL text).
year
}
{}
{ label extra.label sort.label }
%-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------%
%-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------%

INTEGERS { output.state before.all mid.sentence after.sentence after.block }
FUNCTION {is.print.banners.to.terminal}{#1}
%--------------------------------------------------------------------- FILE VERSION AND BANNER ---------------------------------------------------------------------------------%

FUNCTION{bst.file.version} { "1.3" }
FUNCTION{bst.file.date} { "2019/03/10" }
FUNCTION{bst.file.website} { "http://www.parsilatex.com" }
FUNCTION{bst.file.author} {"Sh.Madadpour" }
FUNCTION {banner.message}
{ is.print.banners.to.terminal
     { "-- alpha-persian.bst version" " " * bst.file.version *
       " (" * bst.file.date * ") " * %"by " * bst.file.author *
       top$
       "-- This is a BibTeX style for XePersian and also without it: " bst.file.website *
       %top$
       %" " *
       top$
     }
     { skip$ }
   if$
}

FUNCTION {completed.message}
{ is.print.banners.to.terminal
     { ""
       top$
       "Done."
       top$
     }
     { skip$ }
   if$
}
%------------------------------------------------------------------------------------------------------------------------------------------------------------------------------%
%------------------------------------------------------------------------------------------------------------------------------------------------------------------------------%

FUNCTION {init.state.consts}
{ #0 'before.all :=
  #1 'mid.sentence :=
  #2 'after.sentence :=
  #3 'after.block :=
}

STRINGS { s t }
FUNCTION {output.nonnull}
{ 's :=
  output.state mid.sentence =
    { ", " * write$ }
    { output.state after.block =
        { add.period$ write$
          newline$
          "\newblock " write$
        }
        { output.state before.all =
            'write$
            { add.period$ " " * write$ }
          if$
        }
      if$
      mid.sentence 'output.state :=
    }
  if$
  s
}
FUNCTION {author.mkey.label}
{ author empty$
    { key empty$
        { cite$ #1 #3 substring$ }
        { key #3 text.prefix$ }
      if$
    }
    { ""}
  if$
}
%----------------------------------------------------------------------------------add and change-----------------------------------------------------------------------------%
%-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------%

FUNCTION {format.mlabel}
{slabel empty$
{mlabel empty$
{label}
{"" mlabel * 
year  purify$ #-1 #2 substring$ *}
 if$
}
{"" slabel * }
 if$
}

FUNCTION {format.madadurltest}
{
madadurltest empty$
{quotation empty$
{title "t" change.case$}
{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
{" ''" title "`` " * * "t" change.case$}
{" ``" title "'' " * * "t" change.case$}
 if$
 }
if$
}
{
quotation empty$
{"\href{" murl * "}{" title   *   "}" * * "t" change.case$}
{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
{"\href{" murl * "}{''" title * "``}" * * "t" change.case$}
{"\href{" murl * "}{``" title * "''}" * * "t" change.case$}
if$
}
if$
}
if$
}

FUNCTION {format.title}
{ title empty$
{ "" }
{format.madadurltest}
  if$
}

FUNCTION {format.url}
{
url empty$
{ "" }
{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
{"لینک: \url{" url * "}" * }
{"URL: \url{" url * "}" * }
if$
}
if$
}

FUNCTION {format.doi}
{
doi empty$
{ "" }
{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
{"شناسه‌ی دیجیتال: \doi{" doi * "}" * }
{"\ldoi{" doi * "}" * }
if$
}
if$
}
FUNCTION {format.isbn}
{
isbn empty$
{ "" }
{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
{"شابک: \isbn{" isbn * "}" * }
{"\lisbn{" isbn * "}" * }
if$
}
if$
}

FUNCTION {format.issn}
{
issn empty$
{ "" }
{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
{"شاپا: \issn{" issn * "}" * }
{"\lissn{" issn * "}" * }
if$
}
if$
}

FUNCTION {output.bibitem}
{
  newline$
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
    { skip$ }
    {
     "\begin{LTRbibitems}" write$
      newline$ 
     "\resetlatinfont " write$  
    }
if$
newline$
"\bibitem[" write$
format.mlabel write$
"]{" write$
cite$ write$
"}" write$
newline$
""
before.all 'output.state :=
}

FUNCTION {fin.entry}
{ add.period$
  write$
  newline$
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
    {skip$}
    { newline$
      "\end{LTRbibitems}" write$
      newline$
    }
  if$
}
%-------------------------------------------------------------------------some persian language  setting----------------------------------------------------------------------%
%-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------%

FUNCTION {output}
{ duplicate$ empty$
    'pop$
    'output.nonnull
  if$
}

FUNCTION {output.check}
{ 't :=
  duplicate$ empty$
    { pop$ "empty " t * " in " * cite$ * warning$ }
    'output.nonnull
  if$
}
FUNCTION {new.block}
{ output.state before.all =
    'skip$
    { after.block 'output.state := }
  if$
}

FUNCTION {new.sentence}
{ output.state after.block =
    'skip$
    { output.state before.all =
        'skip$
        { after.sentence 'output.state := }
      if$
    }
  if$
}

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

FUNCTION {new.block.checka}
{ empty$
    'skip$
    'new.block
  if$
}

FUNCTION {new.block.checkb}
{ empty$
  swap$ empty$
  and
    'skip$
    'new.block
  if$
}

FUNCTION {new.sentence.checka}
{ empty$
    'skip$
    'new.sentence
  if$
}

FUNCTION {new.sentence.checkb}
{ empty$
  swap$ empty$
  and
    'skip$
    'new.sentence
  if$
}

FUNCTION {field.or.null}
{ duplicate$ empty$
    { pop$ "" }
    'skip$
  if$
}

FUNCTION {emphasize}
{ duplicate$ empty$
    { pop$ "" }
    { "{\em " swap$ * "}" * }
  if$
}

INTEGERS { nameptr namesleft numnames }

FUNCTION {format.names}
{ 's :=
  #1 'nameptr :=
  s num.names$ 'numnames :=
  numnames 'namesleft :=
    { namesleft #0 > }
    { s nameptr "{ff~}{vv~}{ll}{, jj}" format.name$ 't :=
      nameptr #1 >
        { namesleft #1 >
            { ", " * t * }
            { numnames #2 >
                { "," * }
                'skip$
              if$
              t "others" =
			  {
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
                { " سایرین." * }
				 { " and et~al." * }
				if$
            }
			  {
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
                { " و " * t * }
				 { " and " * t * }
				if$
            }
              if$
            }
          if$
        }
        't
      if$
      nameptr #1 + 'nameptr :=
      namesleft #1 - 'namesleft :=
    }
  while$
}

FUNCTION {format.authors}
{ author empty$
    { "" }
    { author format.names }
  if$
}

FUNCTION {format.editors}
{ editor empty$
    { "" }
    { editor format.names
      editor num.names$ #1 >
	  {
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
	   { ", ویراستاران" * }
        { ", editors" * }
		 if$
    }
	 {
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
        { ", ویراستار" * }
		 { ", editor" * }
			 if$
    }
      if$
    }
  if$
}



FUNCTION {n.dashify}
{ 't :=
  ""
    { t empty$ not }
    { t #1 #1 substring$ "-" =
        { t #1 #2 substring$ "--" = not
            { "--" *
              t #2 global.max$ substring$ 't :=
            }
            {   { t #1 #1 substring$ "-" = }
                { "-" *
                  t #2 global.max$ substring$ 't :=
                }
              while$
            }
          if$
        }
        { t #1 #1 substring$ *
          t #2 global.max$ substring$ 't :=
        }
      if$
    }
  while$
}

FUNCTION {format.date}
{ year empty$
    { month empty$
        { "" }
        { "there's a month but no year in " cite$ * warning$
          month
        }
      if$
    }
    { month empty$
        'year
        { month " " * year * }
      if$
    }
  if$
}

FUNCTION {format.btitle}
{format.madadurltest   emphasize
}




FUNCTION {tie.or.space.connect}
{ duplicate$ text.length$ #3 <
    { "~" }
    { " " }
  if$
  swap$ * *
}

FUNCTION {either.or.check}
{ empty$
    'pop$
    { "can't use both " swap$ * " fields in " * cite$ * warning$ }
  if$
}

FUNCTION {format.bvolume}
{ volume empty$
    { "" }
	{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
	{
	"جلد" volume tie.or.space.connect
      series empty$
        'skip$
        { " از " * series emphasize * }
      if$
   "volume and number" number either.or.check
	}
    { "volume" volume tie.or.space.connect
      series empty$
        'skip$
        { " of " * series emphasize * }
      if$
      "volume and number" number either.or.check
    }
	if$
	}
  if$
}

FUNCTION {format.number.series}
{ volume empty$
    { number empty$
        { series field.or.null }
        { output.state mid.sentence =
		 { language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
		 { "شماره‌ی" }
            { "number" }
			if$
        }
         { language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
		 { "شماره‌ی" }
            { "Number" }
			if$
        }   
          if$
          number tie.or.space.connect
          series empty$
            { "there's a number but no series in " cite$ * warning$ }
			{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
			{ " در " * series * }
            { " in " * series * }
			if$
			}
          if$
        }
      if$
    }
    { "" }
  if$
}


FUNCTION {format.edition}
{ edition empty$
    { "" }
    { language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
    {
  "ویرایش " edition *
}
{
      output.state mid.sentence =
       { edition "l" change.case$ " edition" * }
       { edition "t" change.case$ " edition" * }
          if$
}
  if$
    }
  if$
}


INTEGERS { multiresult }

FUNCTION {multi.page.check}
{ 't :=
  #0 'multiresult :=
    { multiresult not
      t empty$ not
      and
    }
    { t #1 #1 substring$
      duplicate$ "-" =
      swap$ duplicate$ "," =
      swap$ "+" =
      or or
        { #1 'multiresult := }
        { t #2 global.max$ substring$ 't := }
      if$
    }
  while$
  multiresult
}

FUNCTION {format.pages}
{ pages empty$
    { "" }
    { pages multi.page.check
	{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
	{ "صفحات" pages n.dashify tie.or.space.connect }
        { "pages" pages n.dashify tie.or.space.connect }
		if$
		}
		{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
		 { "صفحه‌ی" pages tie.or.space.connect }
        { "page" pages tie.or.space.connect }
		if$
		}
      if$
    }
  if$
}


FUNCTION {format.vol.num.pages}
{ volume field.or.null
  number empty$
    'skip$
    { "(" number * ")" * *
      volume empty$
        { "there's a number but no volume in " cite$ * warning$ }
        'skip$
      if$
    }
  if$
  pages empty$
    'skip$
    { duplicate$ empty$
        { pop$ format.pages }
        {
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
		{"\setlatin{:} " * pages n.dashify *}
		{":" * pages n.dashify *}
		 if$
		}
      if$
    }
  if$
}

FUNCTION {format.chapter.pages}
{ chapter empty$
    'format.pages
    { type empty$
	{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
        {"فصل" }
		{"chapter" }
		if$
    }
        { type "l" change.case$ }
      if$
      chapter tie.or.space.connect
      pages empty$
        'skip$
        { ", " * format.pages * }
      if$
    }
  if$
}

FUNCTION {format.in.ed.booktitle}
{ booktitle empty$
    { "" }
    { editor empty$
        {
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
{"در " booktitle emphasize *}
{"In " booktitle emphasize *}
if$
}
{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
{"در " format.editors * ", " * booktitle emphasize *}
{"In " format.editors * ", " * booktitle emphasize *}
if$
		}
      if$
    }
  if$
}

FUNCTION {empty.misc.check}
{ author empty$ title empty$ howpublished empty$
  month empty$ year empty$ note empty$
  and and and and and
  key empty$ not and
    { "all relevant fields are empty in " cite$ * warning$ }
    'skip$
  if$
}

FUNCTION {format.thesis.type}
{ type empty$
    'skip$
    { pop$
      type "t" change.case$
    }
  if$
}

FUNCTION {format.tr.number}
{ type empty$
	{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
    { "گزارش فنی" }
	 { "Technical Report" }
  if$
}
    'type
  if$
  number empty$
    { "t" change.case$ }
    { number tie.or.space.connect }
  if$
}

FUNCTION {format.article.crossref}
{ key empty$
    { journal empty$
        { "need key or journal for " cite$ * " to crossref " * crossref *
          warning$
          ""
        }
        {
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
		{"در {\em " journal * "\/}" * }
		{"In {\em " journal * "\/}" * }
		if$
		}
      if$
    }
    {
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
{"در " key *} 
{"In " key *} 
if$
	}
  if$
  " \cite{" * crossref * "}" *
}

FUNCTION {format.crossref.editor}
{ editor #1 "{vv~}{ll}" format.name$
  editor num.names$ duplicate$
  #2 >
    { pop$ " et~al." * }
    { #2 <
        'skip$
        { editor #2 "{ff }{vv }{ll}{ jj}" format.name$ "others" =
            { " et~al." * }
            { " and " * editor #2 "{vv~}{ll}" format.name$ * }
          if$
        }
      if$
    }
  if$
}




FUNCTION {format.book.crossref}
{ volume empty$
    { "empty volume in " cite$ * "'s crossref of " * crossref * warning$
		{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
	
	{" در "}
      {" In "}
	  if$
	  }
    }
    {
{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
	{"جلد" volume tie.or.space.connect}
	{"Volume" volume tie.or.space.connect}
	 if$
	  }
		{
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
	 {" از " *}
      {" of " *}
	   if$
	  }
    }
  if$
  editor empty$
  editor field.or.null author field.or.null =
  or
    { key empty$
        { series empty$
            { "need editor, key, or series for " cite$ * " to crossref " *
              crossref * warning$
              "" *
            }
            { "{\em " * series * "\/}" * }
          if$
        }
        { key * }
      if$
    }
    { format.crossref.editor * }
  if$
  " \cite{" * crossref * "}" *
}

FUNCTION {format.incoll.inproc.crossref}
{ editor empty$
  editor field.or.null author field.or.null =
  or
    { key empty$
        { booktitle empty$
            { "need editor, key, or booktitle for " cite$ * " to crossref " *
              crossref * warning$
              ""
            }
            {
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
{"در {\em " booktitle * "\/}" * }
{"In {\em " booktitle * "\/}" * }
if$		
}
          if$
        }
        {
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
{"در " key * }
{"In " key * }
		  if$
		}
      if$
    }
    {
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
{"در " format.crossref.editor * }
	{"In " format.crossref.editor * }
if$
	}
  if$
  " \cite{" * crossref * "}" *
}

FUNCTION {article}
{ output.bibitem
  format.authors "author" output.check
  new.block
  format.title "title" output.check
  new.block
  crossref missing$
    { journal emphasize "journal" output.check
      format.vol.num.pages output
      format.date "year" output.check
    }
    { format.article.crossref output.nonnull
      format.pages output
    }
  if$
new.block
format.issn output
new.block
format.doi output
new.block
format.url output
new.block
note output
fin.entry
}

FUNCTION {book}
{ output.bibitem
  author empty$
    { format.editors "author and editor" output.check }
    { format.authors output.nonnull
      crossref missing$
        { "author and editor" editor either.or.check }
        'skip$
      if$
    }
  if$
  new.block
  format.btitle "title" output.check
  crossref missing$
    { format.bvolume output
      new.block
      format.number.series output
      new.sentence
      publisher "publisher" output.check
      address output
    }
    { new.block
      format.book.crossref output.nonnull
    }
  if$
  format.edition output
  format.date "year" output.check
new.block
format.isbn output
  new.block
  format.doi output
new.block
format.url output
new.block
  note output
  fin.entry
}

FUNCTION {booklet}
{ output.bibitem
  format.authors output
  new.block
  format.title "title" output.check
  howpublished address new.block.checkb
  howpublished output
  address output
  format.date output
 new.block
format.isbn output 
new.block
format.doi output
new.block
format.url output
new.block
  note output
  fin.entry
}

FUNCTION {inbook}
{ output.bibitem
  author empty$
    { format.editors "author and editor" output.check }
    { format.authors output.nonnull
      crossref missing$
        { "author and editor" editor either.or.check }
        'skip$
      if$
    }
  if$
  new.block
  format.btitle "title" output.check
  crossref missing$
    { format.bvolume output
      format.chapter.pages "chapter and pages" output.check
      new.block
      format.number.series output
      new.sentence
      publisher "publisher" output.check
      address output
    }
    { format.chapter.pages "chapter and pages" output.check
      new.block
      format.book.crossref output.nonnull
    }
  if$
  format.edition output
  format.date "year" output.check
  new.block
format.isbn output
  new.block
  format.doi output
new.block
format.url output
new.block
  note output
  fin.entry
}

FUNCTION {incollection}
{ output.bibitem
  format.authors "author" output.check
  new.block
  format.title "title" output.check
  new.block
  crossref missing$
    { format.in.ed.booktitle "booktitle" output.check
      format.bvolume output
      format.number.series output
      format.chapter.pages output
      new.sentence
      publisher "publisher" output.check
      address output
      format.edition output
      format.date "year" output.check
    }
    { format.incoll.inproc.crossref output.nonnull
      format.chapter.pages output
    }
  if$
new.block
format.isbn output
  new.block
  format.doi output
new.block
format.url output
new.block
  note output
  fin.entry
}

FUNCTION {inproceedings}
{ output.bibitem
  format.authors "author" output.check
  new.block
  format.title "title" output.check
  new.block
  crossref missing$
    { format.in.ed.booktitle "booktitle" output.check
      format.bvolume output
      format.number.series output
      format.pages output
      address empty$
        { organization publisher new.sentence.checkb
          organization output
          publisher output
          format.date "year" output.check
        }
        { address output.nonnull
          format.date "year" output.check
          new.sentence
          organization output
          publisher output
        }
      if$
    }
    { format.incoll.inproc.crossref output.nonnull
      format.pages output
    }
  if$
 new.block
format.isbn output 
  new.block
  format.doi output
new.block
format.url output
new.block
  note output
  fin.entry
}

FUNCTION {conference} { inproceedings }

FUNCTION {manual}
{ output.bibitem
  author empty$
    { organization empty$
        'skip$
        { organization output.nonnull
          address output
        }
      if$
    }
    { format.authors output.nonnull }
  if$
  new.block
  format.btitle "title" output.check
  author empty$
    { organization empty$
        { address new.block.checka
          address output
        }
        'skip$
      if$
    }
    { organization address new.block.checkb
      organization output
      address output
    }
  if$
  format.edition output
  format.date output
  new.block
format.isbn output
  new.block
  format.doi output
new.block
format.url output
new.block
  note output
  fin.entry
}

FUNCTION {mastersthesis}
{ output.bibitem
  format.authors "author" output.check
  new.block
  format.title "title" output.check
  new.block
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
  {"پایان‌‌نامه‌ی کارشناسی ارشد" format.thesis.type output.nonnull}
 { "Master's thesis" format.thesis.type output.nonnull}
   if$
  school "school" output.check
  address output
  format.date "year" output.check
  new.block
  format.doi output
new.block
format.url output
new.block
  note output
  fin.entry
}

FUNCTION {misc}
{ output.bibitem
  format.authors output
  title howpublished new.block.checkb
  format.title output
  howpublished new.block.checka
  howpublished output
  format.date output
new.block
format.issn output
  new.block
  format.doi output
new.block
format.url output
new.block
  note output
  fin.entry
  empty.misc.check
}

FUNCTION {phdthesis}
{ output.bibitem
  format.authors "author" output.check
  new.block
  format.btitle "title" output.check
  new.block
language missing$
{#0}
{language "l" change.case$ "persian" =}
if$
  {"رساله‌ی دکترا" format.thesis.type output.nonnull}
 { "PhD thesis" format.thesis.type output.nonnull}
   if$
  school "school" output.check
  address output
  format.date "year" output.check
  new.block
  format.doi output
new.block
format.url output
new.block
  note output
  fin.entry
}

FUNCTION {proceedings}
{ output.bibitem
  editor empty$
    { organization output }
    { format.editors output.nonnull }
  if$
  new.block
  format.btitle "title" output.check
  format.bvolume output
  format.number.series output
  address empty$
    { editor empty$
        { publisher new.sentence.checka }
        { organization publisher new.sentence.checkb
          organization output
        }
      if$
      publisher output
      format.date "year" output.check
    }
    { address output.nonnull
      format.date "year" output.check
      new.sentence
      editor empty$
        'skip$
        { organization output }
      if$
      publisher output
    }
  if$
  new.block
format.isbn output
  new.block
  format.doi output
new.block
format.url output
new.block
  note output
  fin.entry
}

FUNCTION {techreport}
{ output.bibitem
  format.authors "author" output.check
  new.block
  format.title "title" output.check
  new.block
  format.tr.number output.nonnull
  institution "institution" output.check
  address output
  format.date "year" output.check
  new.block
  format.doi output
new.block
format.url output
new.block
  note output
  fin.entry
}

FUNCTION {unpublished}
{ output.bibitem
  format.authors "author" output.check
  new.block
  format.title "title" output.check
  new.block
  note "note" output.check
  format.date output
new.block  
format.doi output
new.block
format.url output
new.block
fin.entry
}

FUNCTION {default.type} { misc }

MACRO {jan} {"January"}

MACRO {feb} {"February"}

MACRO {mar} {"March"}

MACRO {apr} {"April"}

MACRO {may} {"May"}

MACRO {jun} {"June"}

MACRO {jul} {"July"}

MACRO {aug} {"August"}

MACRO {sep} {"September"}

MACRO {oct} {"October"}

MACRO {nov} {"November"}

MACRO {dec} {"December"}

MACRO {acmcs} {"ACM Computing Surveys"}

MACRO {acta} {"Acta Informatica"}

MACRO {cacm} {"Communications of the ACM"}

MACRO {ibmjrd} {"IBM Journal of Research and Development"}

MACRO {ibmsj} {"IBM Systems Journal"}

MACRO {ieeese} {"IEEE Transactions on Software Engineering"}

MACRO {ieeetc} {"IEEE Transactions on Computers"}

MACRO {ieeetcad}
 {"IEEE Transactions on Computer-Aided Design of Integrated Circuits"}

MACRO {ipl} {"Information Processing Letters"}

MACRO {jacm} {"Journal of the ACM"}

MACRO {jcss} {"Journal of Computer and System Sciences"}

MACRO {scp} {"Science of Computer Programming"}

MACRO {sicomp} {"SIAM Journal on Computing"}

MACRO {tocs} {"ACM Transactions on Computer Systems"}

MACRO {tods} {"ACM Transactions on Database Systems"}

MACRO {tog} {"ACM Transactions on Graphics"}

MACRO {toms} {"ACM Transactions on Mathematical Software"}

MACRO {toois} {"ACM Transactions on Office Information Systems"}

MACRO {toplas} {"ACM Transactions on Programming Languages and Systems"}

MACRO {tcs} {"Theoretical Computer Science"}

READ

FUNCTION {sortify}
{ purify$
  "l" change.case$
}

INTEGERS { len }

FUNCTION {chop.word}
{ 's :=
  'len :=
  s #1 len substring$ =
    { s len #1 + global.max$ substring$ }
    's
  if$
}

INTEGERS { et.al.char.used }

FUNCTION {initialize.et.al.char.used}
{ #0 'et.al.char.used :=
}

EXECUTE {initialize.et.al.char.used}

FUNCTION {format.lab.names}
{ 's :=
  s num.names$ 'numnames :=
  numnames #1 >
    { numnames #4 >
        { #3 'namesleft := }
        { numnames 'namesleft := }
      if$
      #1 'nameptr :=
      ""
        { namesleft #0 > }
        { nameptr numnames =
            { s nameptr "{ff }{vv }{ll}{ jj}" format.name$ "others" =
                { "{\etalchar{+}}" *
                  #1 'et.al.char.used :=
                }
                { s nameptr "{v{}}{l{}}" format.name$ * }
              if$
            }
            { s nameptr "{v{}}{l{}}" format.name$ * }
          if$
          nameptr #1 + 'nameptr :=
          namesleft #1 - 'namesleft :=
        }
      while$
      numnames #4 >
        { "{\etalchar{+}}" *
          #1 'et.al.char.used :=
        }
        'skip$
      if$
    }
    { s #1 "{v{}}{l{}}" format.name$
      duplicate$ text.length$ #2 <
        { pop$ s #1 "{ll}" format.name$ #3 text.prefix$ }
        'skip$
      if$
    }
  if$
}

FUNCTION {author.key.label}
{ author empty$
    { key empty$
        { cite$ #1 #3 substring$ }
        { key #3 text.prefix$ }
      if$
    }
    { author format.lab.names }
  if$
}

FUNCTION {author.editor.key.label}
{ author empty$
    { editor empty$
        { key empty$
            { cite$ #1 #3 substring$ }
            { key #3 text.prefix$ }
          if$
        }
        { editor format.lab.names }
      if$
    }
    { author format.lab.names }
  if$
}

FUNCTION {author.key.organization.label}
{ author empty$
    { key empty$
        { organization empty$
            { cite$ #1 #3 substring$ }
            { "The " #4 organization chop.word #3 text.prefix$ }
          if$
        }
        { key #3 text.prefix$ }
      if$
    }
    { author format.lab.names }
  if$
}

FUNCTION {editor.key.organization.label}
{ editor empty$
    { key empty$
        { organization empty$
            { cite$ #1 #3 substring$ }
            { "The " #4 organization chop.word #3 text.prefix$ }
          if$
        }
        { key #3 text.prefix$ }
      if$
    }
    { editor format.lab.names }
  if$
}

FUNCTION {calc.label}
{ type$ "book" =
  type$ "inbook" =
  or
    'author.editor.key.label
    { type$ "proceedings" =
        'editor.key.organization.label
        { type$ "manual" =
            'author.key.organization.label
            'author.key.label
          if$
        }
      if$
    }
  if$
  duplicate$
  year field.or.null purify$ #-1 #2 substring$
  *
  'label :=
  year field.or.null purify$ #-1 #4 substring$
  *
  sortify 'sort.label :=
}

FUNCTION {sort.format.names}
{ 's :=
  #1 'nameptr :=
  ""
  s num.names$ 'numnames :=
  numnames 'namesleft :=
    { namesleft #0 > }
    { nameptr #1 >
        { "   " * }
        'skip$
      if$
      s nameptr "{vv{ } }{ll{ }}{  ff{ }}{  jj{ }}" format.name$ 't :=
      nameptr numnames = t "others" = and
        { "et al" * }
        { t sortify * }
      if$
      nameptr #1 + 'nameptr :=
      namesleft #1 - 'namesleft :=
    }
  while$
}

FUNCTION {sort.format.title}
{ 't :=
  "A " #2
    "An " #3
      "The " #4 t chop.word
    chop.word
  chop.word
  sortify
  #1 global.max$ substring$
}

FUNCTION {author.sort}
{ author empty$
    { key empty$
        { "to sort, need author or key in " cite$ * warning$
          ""
        }
        { key sortify }
      if$
    }
    { author sort.format.names }
  if$
}

FUNCTION {author.editor.sort}
{ author empty$
    { editor empty$
        { key empty$
            { "to sort, need author, editor, or key in " cite$ * warning$
              ""
            }
            { key sortify }
          if$
        }
        { editor sort.format.names }
      if$
    }
    { author sort.format.names }
  if$
}

FUNCTION {author.organization.sort}
{ author empty$
    { organization empty$
        { key empty$
            { "to sort, need author, organization, or key in " cite$ * warning$
              ""
            }
            { key sortify }
          if$
        }
        { "The " #4 organization chop.word sortify }
      if$
    }
    { author sort.format.names }
  if$
}

FUNCTION {editor.organization.sort}
{ editor empty$
    { organization empty$
        { key empty$
            { "to sort, need editor, organization, or key in " cite$ * warning$
              ""
            }
            { key sortify }
          if$
        }
        { "The " #4 organization chop.word sortify }
      if$
    }
    { editor sort.format.names }
  if$
}

FUNCTION {presort}
{ calc.label
  sort.label
  "    "
  *
  type$ "book" =
  type$ "inbook" =
  or
    'author.editor.sort
    { type$ "proceedings" =
        'editor.organization.sort
        { type$ "manual" =
            'author.organization.sort
            'author.sort
          if$
        }
      if$
    }
  if$
  *
  "    "
  *
  year field.or.null sortify
  *
  "    "
  *
  title field.or.null
  sort.format.title
  *
  #1 entry.max$ substring$
  'sort.key$ :=
}

ITERATE {presort}

SORT

STRINGS { longest.label last.sort.label next.extra }

INTEGERS { longest.label.width last.extra.num }

FUNCTION {initialize.longest.label}
{ "" 'longest.label :=
  #0 int.to.chr$ 'last.sort.label :=
  "" 'next.extra :=
  #0 'longest.label.width :=
  #0 'last.extra.num :=
}

FUNCTION {forward.pass}
{ last.sort.label sort.label =
    { last.extra.num #1 + 'last.extra.num :=
      last.extra.num int.to.chr$ 'extra.label :=
    }
    { "a" chr.to.int$ 'last.extra.num :=
      "" 'extra.label :=
      sort.label 'last.sort.label :=
    }
  if$
}

FUNCTION {reverse.pass}
{ next.extra "b" =
    { "a" 'extra.label := }
    'skip$
  if$
  label extra.label * 'label :=
  label width$ longest.label.width >
    { label 'longest.label :=
      label width$ 'longest.label.width :=
    }
    'skip$
  if$
  extra.label 'next.extra :=
}

EXECUTE {banner.message}

EXECUTE {initialize.longest.label}

ITERATE {forward.pass}

REVERSE {reverse.pass}

FUNCTION {begin.bib}
{"% Generated by alpha-persian.bst,  version: " bst.file.version * " (" * bst.file.date * ")" *
 write$ newline$
"%This style has been developed to use Persian bibstyle"
 write$ newline$
"%with the xepersian package"
write$ newline$
"% Author: " bst.file.author * 
write$ newline$
et.al.char.used
{ "\newcommand{\etalchar}[1]{$^{#1}$}" write$ newline$ }
'skip$
if$
preamble$ empty$
'skip$
{preamble$ write$ newline$ }
if$
"\newcommand*{\ldoi}[1]{\lr{doi: #1}}"
write$ newline$ 
"\newcommand*{\lisbn}[1]{\lr{ISBN: #1}}"
write$ newline$   
"\expandafter\ifx\csname href\endcsname\relax"
write$ newline$
"\def\href#1#2{#2}\fi"
write$ newline$
"\providecommand{\url}[1]{\texttt{#1}}"
write$ newline$ 
"\newcommand*{\lissn}[1]{\lr{ISSN: #1}}" 
write$ newline$
"\expandafter\ifx\csname urlstyle\endcsname\relax"
write$ newline$
"\providecommand{\doi}[1]{\rl{\setlatin #1}}\else"
write$ newline$
"  \providecommand{\doi}{\begingroup \urlstyle{rm}\Url}\fi"
write$ newline$
"\expandafter\ifx\csname urlstyle\endcsname\relax"
write$ newline$
"\providecommand{\isbn}[1]{\rl{\setlatin #1}}\else"
write$ newline$
"\providecommand{\isbn}{\begingroup \urlstyle{rm}\Url}\fi"
write$ newline$
"\expandafter\ifx\csname urlstyle\endcsname\relax"
write$ newline$
"\providecommand{\issn}[1]{\rl{\setlatin #1}}\else"
write$ newline$
"\providecommand{\issn}{\begingroup \urlstyle{rm}\Url}\fi"
write$ newline$
"\providecommand\noopsort[1]{}"
write$ newline$
"\begin{thebibliography}{"  longest.label  * "}" * 
write$ newline$
}

EXECUTE {begin.bib}

EXECUTE {init.state.consts}

ITERATE {call.type$}

FUNCTION {end.bib}
{ newline$
  "\end{thebibliography}" write$ newline$
}

EXECUTE {end.bib}
EXECUTE{completed.message}
%--------------------------------------------------------------------------------------------------------------------------------------------------------------------------%
%--------------------------------------------------------------------------------------------------------------------------------------------------------------------------%

%>>>% Bib. style "alpha-persian", Persian (farsi)  version of alpha.bst
%>>>% by: Shapour Madadpour March 2019
%>>>% E-mail: madad_sh@yahoo.com
%--------------------------------------------------------------------------------------------------------------------------------------------------------------------------%
%--------------------------------------------------------------------------------------------------------------------------------------------------------------------------%
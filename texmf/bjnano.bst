%%
%% This is file `bjnano.bst',
%% generated with the docstrip utility.
%%
%% The original source files were:
%%
%% beilstein.dtx  (with options: `bst')
%% ----------------------------------------------------------------
%% beilstein -- Support for submissions to the ``Beilstein Journal
%% of Nanotechnology'' published by the Beilstein-Institut
%% zur Foerderung der Chemischen Wissenschaften
%% Version:     2.1
%% E-mail:      journals-support@beilstein-institut.de
%% License:     Released under the LaTeX Project Public License v1.3c or later
%% See          http://www.latex-project.org/lppl.txt
%% ----------------------------------------------------------------
%% 
%% bjnano.bst is based on achemso.bst which is part of the achemso
%% bundle. Some code cleaning and modifications were done and new
%% entry types and fields introduced.
ENTRY
  { address
    author
    booktitle
    chapter
    ctrl-use-title
    ctrl-etal-number
    doi
    edition
    editor
    howpublished
    institution
    journal
    key
    note
    number
    organization
    pages
    publisher
    school
    series
    title
    type
    url
    urldate
    venue
    version
    volume
    year
  }
  {}
  { label
    extra.label
    short.list
  }

INTEGERS { output.state before.all mid.sentence after.sentence }
INTEGERS { after.block after.item author.or.editor }
INTEGERS { separate.by.semicolon }
INTEGERS { is.use.title etal.number }

FUNCTION {init.state.consts}
{ #0 'before.all :=
  #1 'mid.sentence :=
  #2 'after.sentence :=
  #3 'after.block :=
  #4 'after.item :=
}

%% #0 turns off the display of the title for articles
%% #1 enables
FUNCTION {default.is.use.title} { #0 }

%% The number of names that force "et al." to be used
FUNCTION {default.etal.number} { #100 }

FUNCTION {add.comma}
{ ", " * }

FUNCTION {add.semicolon}
{ "; " * }

FUNCTION {add.comma.or.semicolon}
{ #1 separate.by.semicolon =
    'add.semicolon
    'add.comma
  if$
}

FUNCTION {add.colon}
{ ": " * }

STRINGS { s t }

FUNCTION {output.nonnull}
{ 's :=
  output.state mid.sentence =
    { add.comma write$ }
    { output.state after.block =
      { add.semicolon write$
        newline$
        "\newblock " write$
      }
      { output.state before.all =
          'write$
          { output.state after.item =
            { " " * write$ }
            { add.period$ " " * write$ }
          if$
          }
        if$
        }
      if$
      mid.sentence 'output.state :=
    }
  if$
  s
}

FUNCTION {output}
{ duplicate$ empty$
    'pop$
    'output.nonnull
  if$
}

FUNCTION {output.check}
{ 't :=
  duplicate$ empty$
    { pop$ "Empty " t * " in " * cite$ * warning$ }
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

FUNCTION {fin.entry}
{ add.period$
  write$
""
  newline$
  note missing$
  'skip$
  {" " write$ note write$ }
  if$
  write$ newline$
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

FUNCTION {field.or.null}
{ duplicate$ empty$
    { pop$ "" }
    'skip$
  if$
}

FUNCTION {emphasize}
{ duplicate$ empty$
    { pop$ "" }
    { "\emph{" swap$ * "}" * }
  if$
}

FUNCTION {boldface}
{ duplicate$ empty$
    { pop$ "" }
    { "\textbf{" swap$ * "}" * }
  if$
}

FUNCTION {paren}
{ duplicate$ empty$
    { pop$ "" }
    { "(" swap$ * ")" * }
  if$
}

FUNCTION {bbl.and}
{ "and" }

FUNCTION {bbl.chapter}
{ "Chapter" }

FUNCTION {bbl.editor}
{ "Ed." }

FUNCTION {bbl.editors}
{ "Eds." }

FUNCTION {bbl.edition}
{ "ed." }

FUNCTION {bbl.etal}
{ "et~al." }

FUNCTION {bbl.in}
{ "In" }

FUNCTION {bbl.inpress}
{ "in press" }

FUNCTION {bbl.page}
{ "p" }

FUNCTION {bbl.pages}
{ "pp" }

FUNCTION {bbl.phd}
{ "Ph.\,D.\ Thesis" }

FUNCTION {bbl.submitted}
{ "submitted for publication" }

FUNCTION {bbl.volume}
{ "Vol." }

FUNCTION {bbl.first}
{ "1st" }

FUNCTION {bbl.second}
{ "2nd" }

FUNCTION {bbl.third}
{ "3rd" }

FUNCTION {bbl.fourth}
{ "4th" }

FUNCTION {bbl.fifth}
{ "5th" }

FUNCTION {bbl.st}
{ "st" }

FUNCTION {bbl.nd}
{ "nd" }

FUNCTION {bbl.rd}
{ "rd" }

FUNCTION {bbl.th}
{ "th" }

FUNCTION {eng.ord}
{ duplicate$ "1" swap$ *
  #-2 #1 substring$ "1" =
     { bbl.th * }
     { duplicate$ #-1 #1 substring$
       duplicate$ "1" =
         { pop$ bbl.st * }
         { duplicate$ "2" =
             { pop$ bbl.nd * }
             { "3" =
                 { bbl.rd * }
                 { bbl.th * }
               if$
             }
           if$
          }
       if$
     }
   if$
}

FUNCTION {is.a.digit}
{ duplicate$ "" =
    {pop$ #0}
    {chr.to.int$ #48 - duplicate$
     #0 < swap$ #9 > or not}
  if$
}

FUNCTION {is.a.number}
{
  { duplicate$ #1 #1 substring$ is.a.digit }
    {#2 global.max$ substring$}
  while$
  "" =
}

FUNCTION {extract.num}
{ duplicate$ 't :=
  "" 's :=
  { t empty$ not }
  { t #1 #1 substring$
    t #2 global.max$ substring$ 't :=
    duplicate$ is.a.number
      { s swap$ * 's := }
      { pop$ "" 't := }
    if$
  }
  while$
  s empty$
    'skip$
    { pop$ s }
  if$
}

FUNCTION {chr.to.value}
{ chr.to.int$ #48 -
  duplicate$ duplicate$
  #0 < swap$ #9 > or
    { #48 + int.to.chr$
      " is not a number..." *
      warning$
     pop$ #0
    }
    {}
  if$
}

%% Some tricks from "Tame the BeaST" to convert a string
%% to a number
INTEGERS { a b }

FUNCTION {mult}
{ 'a :=
  'b :=
  b #0 <
    {#-1 #0 b - 'b :=}
    {#1}
  if$
  #0
  {b #0 >}
    { a +
      b #1 - 'b :=
    }
  while$
  swap$
    'skip$
    {#0 swap$ -}
    if$
}

FUNCTION {str.to.int.aux}
{ {duplicate$ empty$ not}
    { swap$ #10 mult 'a :=
      duplicate$ #1 #1 substring$
      chr.to.value a +
      swap$
     #2 global.max$ substring$
    }
  while$
  pop$
}

FUNCTION {str.to.int}
{ duplicate$ #1 #1 substring$ "-" =
    {#1 swap$ #2 global.max$ substring$}
    {#0 swap$}
  if$
  #0 swap$ str.to.int.aux
  swap$
    {#0 swap$ -}
    {}
  if$
}

FUNCTION {bibinfo.check}
{ swap$
  duplicate$ missing$
    { pop$ pop$
      ""
    }
    { duplicate$ empty$
        {
          swap$ pop$
        }
        { swap$
          pop$
        }
      if$
    }
  if$
}

FUNCTION {convert.edition}
{ extract.num "l" change.case$ 's :=
  s "first" = s "1" = or
    { bbl.first 't := }
    { s "second" = s "2" = or
        { bbl.second 't := }
        { s "third" = s "3" = or
            { bbl.third 't := }
            { s "fourth" = s "4" = or
                { bbl.fourth 't := }
                { s "fifth" = s "5" = or
                    { bbl.fifth 't := }
                    { s #1 #1 substring$ is.a.number
                        { s eng.ord 't := }
                        { edition 't := }
                      if$
                    }
                  if$
                }
              if$
            }
          if$
        }
      if$
    }
  if$
  t
}

FUNCTION {tie.or.space.connect}
{ duplicate$ text.length$ #3 <
    { "~" }
    { " " }
  if$
  swap$ * *
}

FUNCTION {space.connect}
{ " " swap$ * * }

INTEGERS { nameptr namesleft numnames }

FUNCTION {format.names}
{ 's :=
  #1 'nameptr :=
  s num.names$ 'numnames :=
  numnames 'namesleft :=
  numnames etal.number > etal.number #0 > and
    { s #1 "{vv~}{ll,}{~f.}{,~jj}" format.name$ 't :=
      t bbl.etal space.connect
    }
    {
       { namesleft #0 > }
       { s nameptr "{vv~}{ll,}{~f.}{,~jj}" format.name$ 't :=
           nameptr #1 >
             { namesleft #1 >
               { add.comma.or.semicolon t * }
               { numnames #2 >
                 { "" * }
                 'skip$
               if$
               t "others," =
                 { bbl.etal space.connect }
                 { add.comma.or.semicolon t * }
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
  if$
}

FUNCTION {format.authors}
{ author empty$
    { "" }
    { #1 'author.or.editor :=
        #1 'separate.by.semicolon :=
      author format.names
    }
  if$
}

FUNCTION {format.editors}
{ editor empty$
    { "" }
    { #2 'author.or.editor :=
        #0 'separate.by.semicolon :=
      editor format.names
      add.comma
      editor num.names$ #1 >
        { bbl.editors }
        { bbl.editor }
      if$
      *
    }
  if$
}

FUNCTION {n.separate.multi}
{ 't :=
  ""
  #0 'numnames :=
  t text.length$ #4 > t is.a.number and
    {
      { t empty$ not }
      { t #-1 #1 substring$ is.a.number
          { numnames #1 + 'numnames := }
          { #0 'numnames := }
        if$
        t #-1 #1 substring$ swap$ *
        t #-2 global.max$ substring$ 't :=
        numnames #4 =
          { duplicate$ #1 #1 substring$ swap$
            #2 global.max$ substring$
            "," swap$ * *
            #1 'numnames :=
          }
          'skip$
        if$
      }
      while$
    }
    { t swap$ * }
  if$
}

FUNCTION {format.bvolume}
{ volume empty$
    { "" }
    { bbl.volume volume tie.or.space.connect }
  if$
}

FUNCTION {format.title.noemph}
{ 't :=
  t empty$
    { "" }
    { t }
  if$
}

FUNCTION {format.title}
{ 't :=
  t empty$
    { "" }
    { t emphasize }
  if$
}

%% The add.title function only does anything if the appropriate
%% flag is set.
FUNCTION {add.title}
{ is.use.title
    { title format.title.noemph "title" output.check
      new.sentence }
    'skip$
  if$
}

FUNCTION {format.number.series}
{ volume empty$
    { number empty$
       { series field.or.null }
       { series empty$
         { "There is a number but no series in " cite$ * warning$ }
         { series number space.connect }
       if$
       }
      if$
    }
    { "" }
  if$
}

FUNCTION {format.url}
{ url empty$
    { "There is no url in " cite$ * warning$ }
    { new.sentence "\url{" url * "}" * }
  if$
}

FUNCTION {format.urldate}
{ urldate empty$
    { "There is no urldate in " cite$ * warning$ }
    { "accessed " urldate * paren space.connect }
  if$
}

FUNCTION {format.full.names}
{'s :=
  #1 'nameptr :=
  s num.names$ 'numnames :=
  numnames 'namesleft :=
    { namesleft #0 > }
    { s nameptr
      "{vv~}{ll}" format.name$ 't :=
      nameptr #1 >
        {
          namesleft #1 >
            { ", " * t * }
            {
              numnames #2 >
                { "," * }
                'skip$
              if$
              t "others" =
                { bbl.etal * }
                { bbl.and space.connect t space.connect }
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

FUNCTION {author.editor.full}
{ author empty$
    { editor empty$
        { "" }
        { editor format.full.names }
      if$
    }
    { author format.full.names }
  if$
}

FUNCTION {author.full}
{ author empty$
    { "" }
    { author format.full.names }
  if$
}

FUNCTION {editor.full}
{ editor empty$
    { "" }
    { editor format.full.names }
  if$
}

FUNCTION {make.full.names}
{ type$ "book" =
  type$ "inbook" =
  or
    'author.editor.full
    { type$ "proceedings" =
        'editor.full
        'author.full
      if$
    }
  if$
}

FUNCTION {output.bibitem}
{ newline$
  "\setboolean{nobreakdashused}{false}" write$
  "\bibitem[" write$
  label write$
  ")" make.full.names duplicate$ short.list =
     { pop$ }
     { * }
   if$
  "]{" * write$
  cite$ write$
  "}" write$
  newline$
  ""
  before.all 'output.state :=
}

FUNCTION {n.dashify}
{ 't :=
  ""
    { t empty$ not }
    { t #1 #1 substring$ "-" =
    { t #1 #2 substring$ "--" = not
        { "\mynobreakdash " *
          t #2 global.max$ substring$ 't :=
        }
        {   { t #1 #1 substring$ "-" = }
        { "\mynobreakdash " *
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
    { "" }
    { year boldface }
  if$
}

FUNCTION {format.bdate}
{ year empty$
    { "There's no year in " cite$ * warning$ }
    'year
  if$
}

FUNCTION {either.or.check}
{ empty$
    'pop$
    { "Can't use both " swap$ * " fields in " * cite$ * warning$ }
  if$
}

FUNCTION {format.edition}
{ edition duplicate$ empty$
    'skip$
    { convert.edition
      bbl.edition bibinfo.check
      " " * bbl.edition *
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
      { bbl.pages pages n.dashify tie.or.space.connect }
      { bbl.page pages tie.or.space.connect }
    if$
    }
  if$
}

FUNCTION {format.pages.required}
{ pages empty$
    { ""
      "There are no page numbers for " cite$ * warning$
      output
    }
    { pages multi.page.check
      { bbl.pages pages n.dashify tie.or.space.connect }
      { bbl.page pages tie.or.space.connect }
    if$
    }
  if$
}

FUNCTION {format.pages.nopp}
{ pages empty$
    { ""
      "There are no page numbers for " cite$ * warning$
      output
    }
    { pages multi.page.check
      { pages n.dashify space.connect }
      { pages space.connect }
    if$
    }
  if$
}

FUNCTION {format.pages.patent}
{ pages empty$
    { "There is no patent number for " cite$ * warning$ }
    { pages multi.page.check
      { pages n.dashify }
      { pages n.separate.multi }
      if$
    }
  if$
}

FUNCTION {format.vol.pages}
{ volume emphasize field.or.null
number empty$
   'skip$
   { number paren tie.or.space.connect }
if$
duplicate$ empty$
    { pop$ format.pages.required }
    { add.comma pages n.dashify * }
  if$
}

FUNCTION {format.chapter.pages}
{ chapter empty$
    'format.pages
    { type empty$
    { bbl.chapter }
    { type "l" change.case$ }
      if$
      chapter tie.or.space.connect
      pages empty$
    'skip$
    { add.comma format.pages * }
      if$
    }
  if$
}

FUNCTION {format.title.in}
{ 's :=
  s empty$
    { "" }
    { editor empty$
      { bbl.in s format.title space.connect }
      { bbl.in s format.title space.connect
        add.semicolon format.editors *
      }
    if$
    }
  if$
}

FUNCTION {format.proc.title.in}
{ 's :=
  s empty$
    { "" }
    { editor empty$
      { bbl.in s format.title space.connect }
      { venue empty$
        { bbl.in s format.title space.connect
          add.semicolon format.editors * }
        { bbl.in s format.title space.connect
          add.comma venue *
          add.semicolon format.editors * }
      if$
      }
    if$
    }
  if$
}

FUNCTION {format.pub.address}
{ publisher empty$
    { "" }
    { address empty$
        { publisher }
        { publisher add.colon address *}
      if$
    }
  if$
}

FUNCTION {format.school.address}
{ school empty$
    { "" }
    { address empty$
        { school }
        { school add.colon address *}
      if$
    }
  if$
}

FUNCTION {format.organization.address}
{ organization empty$
    { "" }
    { address empty$
        { organization }
        { organization add.colon address *}
      if$
    }
  if$
}

FUNCTION {format.venue}
{ venue empty$
    { "" }
    { venue add.semicolon}
  if$
}

FUNCTION {empty.misc.check}
{ note empty$
    { "note field is empty in " cite$ * warning$ }
    'skip$
  if$
}

FUNCTION {empty.doi.note}
{ doi empty$ note empty$ and
    { "Need either a note or DOI for " cite$ * warning$ }
    'skip$
  if$
}

FUNCTION {format.thesis.type}
{ type empty$
    'skip$
    { pop$
      type
    }
  if$
}

FUNCTION {format.doi}
{ doi empty$
{ "  "} % 'skip$
    { new.sentence "\url{doi:" doi tie.or.space.connect "}" * }
  if$
}

FUNCTION {article}
{ output.bibitem
  author empty$
  { format.editors "editor" output.check
   after.item 'output.state :=
   title empty$
    'skip$
    { title format.title.noemph output
      after.sentence 'output.state :=
    }
   if$
   journal emphasize "journal" output.check
  }
  { format.authors "author" output.check
  after.item 'output.state :=
  add.title
  journal emphasize "journal" output.check
  }
  if$
  after.item 'output.state :=
  format.date "year" output.check
  volume empty$
    { number empty$
   { "There is neither volume nor number given for " cite$ * warning$ }
     { "No. " number * output}
   if$
     ""
      format.pages.nopp output
    }
    { format.vol.pages output }
  if$
  format.doi output
  fin.entry
  }

FUNCTION {book}
{ output.bibitem
  author empty$
    { booktitle empty$
        { title format.title "title" output.check }
        { booktitle format.title "booktitle" output.check }
      if$
      format.edition output
      new.block
      editor empty$
        { "Need either an author or editor for " cite$ * warning$ }
        { "" format.editors * "editor" output.check }
      if$
    }
    { format.authors output
      after.item 'output.state :=
      "author and editor" editor either.or.check
      booktitle empty$
        { title format.title "title" output.check }
        { booktitle format.title "booktitle" output.check }
      if$
      format.edition output
    }
  if$
  new.block
  format.number.series output
  new.block
  format.pub.address "publisher" output.check
  format.bdate "year" output.check
  new.block
  format.bvolume output
  pages empty$
    'skip$
    { format.pages output }
  if$
  format.doi output
  fin.entry
}

FUNCTION {booklet}
{ "Entrytype booklet of " cite$ " is not supported." * * warning$ }

FUNCTION {inbook}
{ output.bibitem
  author empty$
    { booktitle format.title "booktitle" output.check
      format.edition output
      new.block
      editor empty$
        { "Need at least an author or an editor for " cite$ * warning$ }
        { "" format.editors * "editor" output.check }
      if$
    }
    { format.authors output
      after.item 'output.state :=
      title empty$
        'skip$
        { title format.title.noemph output }
      if$
      after.sentence 'output.state :=
      booktitle format.title.in "booktitle" output.check
      format.edition output
    }
  if$
  new.block
  format.number.series output
  new.block
  format.pub.address "publisher" output.check
  format.bdate "year" output.check
  new.block
  format.bvolume output
  format.chapter.pages "chapter and pages" output.check
  fin.entry
}

FUNCTION {incollection}
{ output.bibitem
  author empty$
    { booktitle format.title "booktitle" output.check
      format.edition output
      new.block
      editor empty$
        { "Need at least an author or an editor for " cite$ * warning$ }
        { "" format.editors * "editor" output.check }
      if$
    }
    { format.authors output
      after.item 'output.state :=
      title empty$
        'skip$
        { title format.title.noemph output }
      if$
      after.sentence 'output.state :=
      booktitle format.title.in "booktitle" output.check
      format.edition output
    }
  if$
  new.block
  format.number.series output
  new.block
  format.pub.address "publisher" output.check
  format.bdate "year" output.check
  new.block
  format.bvolume output
  format.chapter.pages "chapter and pages" output.check
  format.doi output
  fin.entry
}

FUNCTION {inpress}
{ output.bibitem
  format.authors "author" output.check
  after.item 'output.state :=
  journal emphasize "journal" output.check
  doi empty$
    {  bbl.inpress output }
    {  after.item 'output.state :=
       format.date output
       "doi:" doi tie.or.space.connect output
    }
  if$
  format.doi output
  fin.entry
}

FUNCTION {inproceedings}
{ output.bibitem
  format.authors "author" output.check
  after.item 'output.state :=
  title empty$
    'skip$
    { title format.title.noemph output
      after.sentence 'output.state :=
    }
  if$
  booktitle format.proc.title.in "booktitle" output.check
  new.block
  format.pub.address "publisher" output.check
  format.bdate "year" output.check
  pages empty$
    'skip$
    { new.block
      format.pages output }
  if$
  format.doi output
  fin.entry
}

FUNCTION {manual}
{ "Entrytype manual of " cite$ " is not supported." * * warning$ }

FUNCTION {mastersthesis}
{ "Entrytype masterthesis of " cite$ " is not supported." * * warning$ }

FUNCTION {misc}
{ output.bibitem
  fin.entry
}

FUNCTION {online}
{ output.bibitem
  format.authors output
  after.item 'output.state :=
  title empty$
    'skip$
    { title output }
  if$
  format.url output
  after.item 'output.state :=
  format.urldate output
  format.doi output
  fin.entry
}

FUNCTION {patent}
{ output.bibitem
  format.authors "author" output.check
  after.item 'output.state :=
  title empty$
    'skip$
    { title format.title.noemph output
      after.sentence 'output.state :=
    }
  if$
  journal "journal" output.check
  after.item 'output.state :=
  format.pages.patent "pages" output.check
  format.bdate "year" output.check
  format.doi output
  fin.entry
}

FUNCTION {phdthesis}
{ output.bibitem
  format.authors "author" output.check
  after.item 'output.state :=
  title empty$
    'skip$
    { title format.title.noemph output
      after.sentence 'output.state :=
    }
  if$
  bbl.phd format.thesis.type output
  format.school.address "school" output.check
  format.bdate "year" output.check
  format.doi output
  fin.entry
}

FUNCTION {proceedings}
{ output.bibitem
format.editors "editor" output.check
after.item 'output.state :=
  title format.title "title" output.check
  venue empty$
    { }
    { venue output
      add.semicolon write$ }
  if$
  format.pub.address "publisher" output.check
  format.bdate "year" output.check
  pages empty$
    'skip$
    { new.block
      format.pages output }
  if$
  format.doi output
  fin.entry
}

FUNCTION {software}
{ output.bibitem
  title format.title "title" output.check
  version empty$
   'skip$
   { version output }
  if$
  after.block 'output.state :=
  format.pub.address "publisher" output.check
  format.bdate "year" output.check
  format.doi output
  fin.entry
}

FUNCTION {techreport}
{ "Entrytype techreport of " cite$ " is not supported." * * warning$ }

FUNCTION {unpublished}
{ "Entrytype unpublished of " cite$ " is not supported." * * warning$ }

FUNCTION {www}
{ output.bibitem
  format.authors output
  after.item 'output.state :=
  title empty$
    'skip$
    { title output }
  if$
  format.url output
  after.item 'output.state :=
  format.urldate output
  format.doi output
  fin.entry
}

%% Convert the strings "yes" or "no" to #1 or #0 respectively
FUNCTION {yes.no.to.int}
{ "l" change.case$ duplicate$
    "yes" =
    { pop$  #1 }
    { duplicate$ "no" =
        { pop$ #0 }
        { "unknown Boolean " quote$ * swap$ * quote$ *
          " in " * cite$ * warning$
          #0
        }
      if$
    }
  if$
}

%% Using the same mechanism as in IEEEtrans, control of
%% output can be achieved using a special entry type.
FUNCTION {Control}
{ ctrl-use-title
  empty$
    { }
    { ctrl-use-title
      yes.no.to.int
      'is.use.title := }
  if$
  ctrl-etal-number
  empty$
    { }
    { ctrl-etal-number
      str.to.int
      'etal.number := }
  if$
}

FUNCTION {conference} {inproceedings}

FUNCTION {other} {patent}

FUNCTION {default.type} {misc}

READ

FUNCTION {initialize.controls}
{ default.is.use.title 'is.use.title :=
  default.etal.number 'etal.number :=
}

EXECUTE {initialize.controls}

INTEGERS { len }

FUNCTION {chop.word}
{ 's :=
  'len :=
  s #1 len substring$ =
    { s len #1 + global.max$ substring$ }
    's
  if$
}

FUNCTION {format.lab.names}
{ 's :=
  s #1 "{vv~}{ll}" format.name$
  s num.names$ duplicate$
  #2 >
    { pop$ bbl.etal space.connect }
    { #2 <
        'skip$
        { s #2 "{ff }{vv }{ll}{ jj}" format.name$ "others" =
            { bbl.etal space.connect }
            { bbl.and space.connect s #2 "{vv~}{ll}" format.name$ space.connect
            }
          if$
        }
      if$
    }
  if$
}

FUNCTION {author.key.label}
{ author empty$
    { key empty$
        { cite$ #1 #3 substring$ }
        'key
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
            'key
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
        'key
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
        'key
      if$
    }
    { editor format.lab.names }
  if$
}

FUNCTION {calc.short.authors}
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
  'short.list :=
}

FUNCTION {calc.label}
{ calc.short.authors
  short.list
  "("
  *
  year duplicate$ empty$
  short.list key field.or.null = or
     { pop$ "" }
     'skip$
  if$
  *
  'label :=
}

ITERATE {calc.label}

STRINGS { longest.label last.label next.extra }

INTEGERS { longest.label.width last.extra.num number.label }

FUNCTION {initialize.longest.label}
{ "" 'longest.label :=
  #0 int.to.chr$ 'last.label :=
  "" 'next.extra :=
  #0 'longest.label.width :=
  #0 'last.extra.num :=
  #0 'number.label :=
}

FUNCTION {forward.pass}
{ last.label label =
    { last.extra.num #1 + 'last.extra.num :=
      last.extra.num int.to.chr$ 'extra.label :=
    }
    { "a" chr.to.int$ 'last.extra.num :=
      "" 'extra.label :=
      label 'last.label :=
    }
  if$
  number.label #1 + 'number.label :=
}

EXECUTE {initialize.longest.label}

ITERATE {forward.pass}

FUNCTION {begin.bib}
{ preamble$ empty$
    'skip$
    { preamble$ write$ newline$ }
  if$
  "\begin{thebibliography}{"  number.label int.to.str$  * "}" *
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
%% 
%% Originally developed by Martin Sievers (info@schoenerpublizieren.de)
%% Copyright (C) 2009-2020 by Beilstein-Institut zur Foerderung der Chemischen Wissenschaften (Beilstein)
%% 
%% Part of this bundle is derived from cite.sty, to which the
%% following license applies:
%%   Copyright (C) 1989-2003 by Donald Arseneau
%%   These macros may be freely transmitted, reproduced, or
%%   modified provided that this notice is left intact.
%% 
%% It may be distributed and/or modified under the conditions of
%% the LaTeX Project Public License (LPPL), either version 1.3c of
%% this license or (at your option) any later version.  The latest
%% version of this license is in the file:
%% 
%%    http://www.latex-project.org/lppl.txt
%% 
%% This work has the LPPL maintenancce status "author-maintained".
%% 
%% This work consists of the files beilstein.dtx,
%%                                 CHANGELOG.md,
%%                                 README.md
%%           and the derived files beilstein.pdf,
%%                                 beilstein.cls,
%%                                 beilstein.ins,
%%                                 bjnano.bst,
%%                                 beilstein-template.tex,
%%                                 beilstein-template.bib.
%%           Some graphic files for the documentation and template are also added:
%%                                 bjnano_logo.pdf
%%                                 scheme1.pdf
%%                                 scheme2.pdf
%%                                 figure1.pdf
%%
%% End of file `bjnano.bst'.

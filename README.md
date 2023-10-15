# make-cmake.studio

## El guion de make-cmake

Tenemos el siguiente `makefile` para descargar la pagina `PAGE` que se indique 
y recogerla completa con todos sus elementos en una carpeta `FOLDER`:

El ajuste de `wget` pretende descargar toda esa pagina y no su contexto, 
pero si todos los elementos adicionales que tengan que ver. 

Se aplica un nivel de profundidad de dos (2) con las opciones `-r -l 2`

```bash

PAGE="https://earthly.dev/blog/cmake-vs-make-diff/"
FOLDER="./READMEfiles"
BROWSER=brave-browser
#BROWSER=firefox

wget:
#	make cleanwget
	mkdir -p $(FOLDER)
	echo wget...
	wget -mpEk -np -r -l 2 -P $(FOLDER) -A html,css,jpeg,jpg,bmp,gif,png,pdf $(PAGE)

clean:
	rm -rf $(FOLDER) ./index.html

browselocal:
	find . | grep index | xargs $(BROWSER) &                # lo veo donde esté.

```

## Un sistema modular

Pretendemos *compilacion separada*: 
Cada modolo ha de ser procesable independientemente hasta un formato de objetos enlazables.

Los pasos del workflow son analizables: [ver explicacion](https://stackoverflow.com/questions/8527743/running-gccs-steps-manually-compiling-assembling-linking)

`gcc -E`  --> Preprocessor, but don't compile
`gcc -S`  Compile but don't assemble: --> `.asm` 
`gcc -c`  --> Preprocess, compile, and assemble --> `.o`, but don't linked
`gcc` with no switch: will link your object files and generate the executable

```bash

g++ -E age.cpp  > age.preprocesado.cpp
g++ -E main.cpp > main.preprocesado.cpp

g++ -S age.cpp  # :  age.s (traducido (a ensamblador))
g++ -S main.cpp # : main.s (traducido (a ensamblador))

as  age.s -o age.o  # ensamblado de los objetos en age.s
as main.s -o main.o # ensamblado de los objetos en main.s

g++ -c age.cpp  # :  age.o (ensamblado a objetos)
g++ -c main.cpp # : main.o (ensamblado a objetos)

ld age.p        # enlazado con fallo a muchas referencias...
ld main.o       # enlazado con fallo a muchas referencias...
ld age.o main.o # enlazado con fallo a muchas referencias...

# ¿Un enlazado a mano? ¿y que funcione ??? NO EN ESTE CURSO

ld \
/usr/lib/x86_64-linux-gnu/crti.o \
/usr/lib/x86_64-linux-gnu/crtn.o \
/usr/lib/x86_64-linux-gnu/crt1.o \
main.o \
age.o \
-dynamic-linker /lib64/ld-linux-x86-64.so.2 \
-o main_ELF_executable

```

## TODO list

- [x] b.html cuardando el html descargado, simplificado. 
- [x] w.make (tenia errores)
- [ ] w.cmake TODO
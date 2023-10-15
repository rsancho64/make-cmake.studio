all: main.o age.o
	g++ hello.o age.o -o hello_age.exe
    
main.o: main.cpp
	g++ -c main.cpp -o hello.o
    
age.o: age.cpp
	g++ -c age.cpp
    
clean:
	rm -rf *.o hello_age.exe
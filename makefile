PAGE="https://earthly.dev/blog/cmake-vs-make-diff/"
FOLDER="./wgetfiles"
BROWSER=brave-browser
#BROWSER=firefox

wget:
#	make clean
	mkdir -p $(FOLDER)
	echo wget...
	wget -mpEk -np -r -l 2 -P $(FOLDER) -A html,css,jpeg,jpg,bmp,gif,png,pdf $(PAGE)

clean:
	rm -rf $(FOLDER) ./index.html

browselocal:
	find . | grep index.html | xargs $(BROWSER) & # lo veo donde esté.
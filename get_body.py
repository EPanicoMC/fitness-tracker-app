import urllib.request
url = "https://raw.githubusercontent.com/taniarascia/anatomy/master/anatomy.svg"
try:
    req = urllib.request.urlopen(url)
    print(req.read().decode('utf-8')[:100])
except Exception as e:
    print(e)
